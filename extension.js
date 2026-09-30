const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const companionHooks = require('./hooks');

const CONFIG_NS = 'agentCompanion';

function config() {
	return vscode.workspace.getConfiguration(CONFIG_NS);
}

// 훅 페이로드만으로는 에이전트를 구분할 수 없어서, 이벤트 파일이 쓰인 폴더로 판별한다
const AGENTS = [
	{ id: 'claude', label: 'Claude', processName: 'claude', eventsDir: path.join(os.homedir(), '.claude', 'companion-events') },
	{ id: 'codex', label: 'Codex', processName: 'codex', eventsDir: path.join(os.homedir(), '.codex', 'companion-events') }
];

// ===== 기능 1: 터미널-탐색기 동기화 =====

let lastRevealedPath;
// 포커스 시점에 셸 통합이 아직 준비되지 않아 cwd를 몰랐던 터미널들
const pendingReveal = new WeakSet();

function getTerminalCwd(terminal) {
	if (terminal.shellIntegration && terminal.shellIntegration.cwd) {
		return terminal.shellIntegration.cwd;
	}
	const raw = terminal.creationOptions && terminal.creationOptions.cwd;
	if (!raw) {
		return undefined;
	}
	return typeof raw === 'string' ? vscode.Uri.file(raw) : raw;
}

async function revealCwd(terminal) {
	if (!terminal || !config().get('explorerSync.enabled', true)) {
		return;
	}
	const cwd = getTerminalCwd(terminal);
	if (!cwd || !vscode.workspace.getWorkspaceFolder(cwd) || cwd.toString() === lastRevealedPath) {
		return;
	}
	lastRevealedPath = cwd.toString();
	try {
		await vscode.commands.executeCommand('revealInExplorer', cwd);
		// revealInExplorer는 폴더를 펼치지 않고, 포커스를 탐색기로 가져간다
		await vscode.commands.executeCommand('list.expand');
		if (vscode.window.activeTerminal === terminal) {
			terminal.show(false);
		}
	} catch {}
}

function handleTerminalFocus(terminal) {
	if (!terminal) {
		return;
	}
	if (!(terminal.shellIntegration && terminal.shellIntegration.cwd)) {
		pendingReveal.add(terminal);
	}
	revealCwd(terminal);
}

// ===== 기능 2: 응답 완료 / 입력 대기 알림 =====

const EVENT_STATES = {
	UserPromptSubmit: 'working',
	PostToolUse: 'working',
	// Claude의 permission_prompt. 승인뿐 아니라 선택지 질문에도 발화한다 (2.1.212 실측)
	Notification: 'waiting',
	PermissionRequest: 'waiting', // Codex
	Stop: 'done'
};

// 중복 판정을 "토스트가 떠 있는지"로 하면 안 된다 — 버튼이 있는 토스트는
// 닫기 전까지 남아 있어서, 방치된 토스트 하나가 후속 알림을 전부 막는다
const recentNotifications = new Map();
const NOTIFICATION_DEDUPE_MS = 3000;

// VS Code API에는 알림 사운드가 없어 OS 명령으로 재생한다.
// WSL에서는 리눅스 쪽 오디오 장치가 없어 Windows 알림음을 쓴다 (실측 ~1.8초 지연)
function playNotificationSound() {
	if (!config().get('notifications.sound.enabled', true)) {
		return;
	}
	const isWSL = process.platform === 'linux' && os.release().toLowerCase().includes('microsoft');
	let command;
	if (process.platform === 'win32' || isWSL) {
		command = `powershell.exe -NoProfile -Command "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify System Generic.wav').PlaySync()"`;
	} else if (process.platform === 'darwin') {
		command = 'afplay /System/Library/Sounds/Glass.aiff';
	} else {
		command = 'paplay /usr/share/sounds/freedesktop/stereo/message.oga';
	}
	exec(command, () => {});
}

// Codex는 백그라운드에 `codex app-server` 데몬을 띄워 두는데, 데몬의 cwd가
// 프로젝트 폴더와 겹치면 세션이 살아있는 것으로 오판하므로 제외한다
function isAgentProc(agent, pid) {
	try {
		const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
		return path.basename(argv[0] || '') === agent.processName && argv[1] !== 'app-server';
	} catch {
		return false;
	}
}

function runningAgentProcs(agent) {
	let pids;
	try {
		pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
	} catch {
		return []; // /proc이 없는 플랫폼
	}
	const procs = [];
	for (const pid of pids) {
		if (!isAgentProc(agent, pid)) {
			continue;
		}
		try {
			procs.push({ pid: Number(pid), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
		} catch {}
	}
	return procs;
}

function ppidOf(pid) {
	try {
		const match = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m);
		return match ? Number(match[1]) : 0;
	} catch {
		return 0;
	}
}

async function buildPidToTerminalMap() {
	const pidToTerminal = new Map();
	await Promise.all(
		vscode.window.terminals.map(async (terminal) => {
			try {
				const pid = await terminal.processId;
				if (pid) {
					pidToTerminal.set(pid, terminal);
				}
			} catch {}
		})
	);
	return pidToTerminal;
}

// 부모 체인을 올라가 terminal.processId(셸)와 만나는 터미널을 찾는다.
// Codex는 node 래퍼가 네이티브 바이너리를 띄우는 구조라 셸이 한 단계 더 멀다.
function terminalOfAgentPid(agentPid, pidToTerminal) {
	let pid = agentPid;
	for (let depth = 0; depth < 5; depth++) {
		pid = ppidOf(pid);
		if (!pid || pid <= 1) {
			break;
		}
		const terminal = pidToTerminal.get(pid);
		if (terminal) {
			return terminal;
		}
	}
	return undefined;
}

async function findTerminalForProject(agent, cwdPath) {
	const pidToTerminal = await buildPidToTerminalMap();
	for (const proc of runningAgentProcs(agent)) {
		const terminal = proc.cwd === cwdPath && terminalOfAgentPid(proc.pid, pidToTerminal);
		if (terminal) {
			return terminal;
		}
	}
	return vscode.window.terminals.find((terminal) => {
		const cwd = getTerminalCwd(terminal);
		return cwd && cwd.scheme === 'file' && cwd.fsPath === cwdPath;
	});
}

async function showTerminalForSession(agent, cwd, pid) {
	const terminal =
		(pid && terminalOfAgentPid(pid, await buildPidToTerminalMap())) ||
		(await findTerminalForProject(agent, cwd));
	if (terminal) {
		terminal.show();
	} else {
		vscode.window.showWarningMessage('해당 세션의 터미널을 찾지 못했습니다.');
	}
}

// 파일명: <나노초 타임스탬프>-<셸 pid>-<에이전트 pid>.json (hooks.js 참고).
// 세션 프로세스가 아닌 pid(이미 종료, 데몬이 훅을 실행한 경우 등)는 버리고 cwd로 폴백한다.
function agentPidFromEventFilename(agent, file) {
	const match = path.basename(file).match(/^\d+-\d+-(\d+)\.json$/);
	const pid = match && Number(match[1]);
	return pid && isAgentProc(agent, pid) ? pid : undefined;
}

async function handleCompanionEvent(agent, file, notify = true) {
	let event;
	try {
		event = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return;
	}
	if (!event || typeof event.cwd !== 'string') {
		fs.unlink(file, () => {});
		return;
	}
	// 다른 창에 열린 프로젝트의 이벤트는 그 창이 처리하도록 파일을 남겨 둔다
	if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(event.cwd))) {
		return;
	}
	fs.unlink(file, () => {});

	const state = EVENT_STATES[event.hook_event_name];
	if (!state) {
		return;
	}
	const pid = agentPidFromEventFilename(agent, file);
	setAgentState(agent, event.cwd, state, pid);
	if (!notify) {
		return;
	}

	const title = `(${agent.label}) ${path.basename(event.cwd)}`;
	let message;
	if (state === 'done' && config().get('stopNotification.enabled', true)) {
		message = `✅ ${title} — 응답 완료`;
	} else if (state === 'waiting' && config().get('permissionNotification.enabled', true)) {
		message = `⏸️ ${title} — 입력을 기다립니다`;
	}
	if (!message) {
		return;
	}
	const key = `${agent.id}:${state}:${pid || event.cwd}`;
	const now = Date.now();
	if (now - (recentNotifications.get(key) || 0) < NOTIFICATION_DEDUPE_MS) {
		return;
	}
	recentNotifications.set(key, now);
	playNotificationSound();
	const picked = await vscode.window.showInformationMessage(message, '터미널로 이동');
	if (picked === '터미널로 이동') {
		await showTerminalForSession(agent, event.cwd, pid);
	}
}

function startCompanionEventWatcher(context, agent) {
	// 쓰지 않는 에이전트의 설정 폴더를 만들면 installedTargets()가 설치된 것으로 오판한다
	if (!fs.existsSync(path.dirname(agent.eventsDir))) {
		return;
	}
	try {
		fs.mkdirSync(agent.eventsDir, { recursive: true });
		// 창이 꺼져 있는 동안 쌓인 이벤트는 상태에만 반영한다 (파일명 정렬 = 발생 순서)
		const leftovers = fs
			.readdirSync(agent.eventsDir)
			.filter((name) => name.endsWith('.json'))
			.sort();
		for (const name of leftovers) {
			handleCompanionEvent(agent, path.join(agent.eventsDir, name), false);
		}
		const watcher = fs.watch(agent.eventsDir, (_eventType, filename) => {
			// 훅이 .tmp에 다 쓴 뒤 .json으로 rename하므로 .json이 보이면 쓰기가 끝난 것
			if (filename && filename.endsWith('.json')) {
				handleCompanionEvent(agent, path.join(agent.eventsDir, filename));
			}
		});
		context.subscriptions.push({ dispose: () => watcher.close() });
	} catch (error) {
		console.warn(`agent-companion: ${agent.label} 이벤트 감시 시작 실패`, error);
	}
}

// ===== 기능 3: 세션별 상태 추적 =====

// `${agent.id}:pid:${pid}` 또는 `${agent.id}:cwd:${cwd}` → { agent, cwd, pid, kind, at }
const agentStates = new Map();
let agentStatusItem;

const STATE_ICONS = { waiting: '⏸️', done: '✅', working: '⏳' };
const STATE_LABELS = { waiting: '입력 대기', done: '응답 완료', working: '작업 중' };
const STATE_ORDER = { waiting: 0, done: 1, working: 2 };
const RECONCILE_INTERVAL_MS = 15000;

function setAgentState(agent, cwd, kind, pid) {
	if (!config().get('statusTracker.enabled', true)) {
		return;
	}
	const cwdKey = `${agent.id}:cwd:${cwd}`;
	if (pid) {
		agentStates.delete(cwdKey);
	}
	agentStates.set(pid ? `${agent.id}:pid:${pid}` : cwdKey, { agent, cwd, pid, kind, at: Date.now() });
	updateAgentStatusBar();
}

function reconcileAgentStates() {
	// /proc이 없으면 생존 여부를 알 수 없으므로 지우지 않는다
	if (agentStates.size === 0 || !fs.existsSync('/proc')) {
		return;
	}
	const aliveKeys = new Set();
	for (const agent of AGENTS) {
		for (const proc of runningAgentProcs(agent)) {
			aliveKeys.add(`${agent.id}:pid:${proc.pid}`);
			aliveKeys.add(`${agent.id}:cwd:${proc.cwd}`);
		}
	}
	let changed = false;
	for (const key of [...agentStates.keys()]) {
		if (!aliveKeys.has(key)) {
			agentStates.delete(key);
			changed = true;
		}
	}
	if (changed) {
		updateAgentStatusBar();
	}
}

// 같은 폴더에서 같은 에이전트가 여럿 돌면 이름이 겹치므로 pid를 붙인다
function stateTitler() {
	const nameOf = (state) => `(${state.agent.label}) ${path.basename(state.cwd)}`;
	const nameCounts = new Map();
	for (const state of agentStates.values()) {
		nameCounts.set(nameOf(state), (nameCounts.get(nameOf(state)) || 0) + 1);
	}
	return (state) => {
		const name = nameOf(state);
		const suffix = nameCounts.get(name) > 1 && state.pid ? ` (pid ${state.pid})` : '';
		return `${STATE_ICONS[state.kind]} ${name}${suffix}`;
	};
}

function updateAgentStatusBar() {
	if (!agentStatusItem) {
		return;
	}
	if (agentStates.size === 0 || !config().get('statusTracker.enabled', true)) {
		agentStatusItem.hide();
		return;
	}
	const counts = { waiting: 0, done: 0, working: 0 };
	for (const state of agentStates.values()) {
		counts[state.kind]++;
	}
	agentStatusItem.text = ['waiting', 'done', 'working']
		.filter((kind) => counts[kind] > 0)
		.map((kind) => `${STATE_ICONS[kind]} ${counts[kind]}`)
		.join('  ');
	agentStatusItem.backgroundColor =
		counts.waiting > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
	const stateTitle = stateTitler();
	agentStatusItem.tooltip = [
		'에이전트 세션 상태 — 클릭해서 터미널로 이동',
		...[...agentStates.values()].map((state) => `${stateTitle(state)} — ${STATE_LABELS[state.kind]}`)
	].join('\n');
	agentStatusItem.show();
}

function formatElapsed(ms) {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) {
		return '방금 전';
	}
	if (minutes < 60) {
		return `${minutes}분 경과`;
	}
	return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 경과`;
}

async function agentSessionsQuickPick() {
	reconcileAgentStates();
	if (agentStates.size === 0) {
		vscode.window.showInformationMessage('추적 중인 에이전트 세션이 없습니다.');
		return;
	}
	const stateTitle = stateTitler();
	const items = [...agentStates.values()]
		.sort((a, b) => STATE_ORDER[a.kind] - STATE_ORDER[b.kind] || a.at - b.at)
		.map((state) => ({
			label: stateTitle(state),
			description: `${STATE_LABELS[state.kind]} · ${formatElapsed(Date.now() - state.at)}`,
			detail: state.cwd,
			state
		}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: '에이전트 세션 — 선택하면 해당 터미널로 이동'
	});
	if (picked) {
		await showTerminalForSession(picked.state.agent, picked.state.cwd, picked.state.pid);
	}
}

// ===== 기능 4: Add Path to AI Chat =====

function quoteIfNeeded(text) {
	return /\s/.test(text) ? `"${text}"` : text;
}

function addPathToAiChat(uri, uris) {
	let targets = Array.isArray(uris) && uris.length > 0 ? uris : uri ? [uri] : [];
	if (targets.length === 0 && vscode.window.activeTextEditor) {
		targets = [vscode.window.activeTextEditor.document.uri];
	}
	targets = targets.filter((target) => target && target.scheme === 'file');
	if (targets.length === 0) {
		vscode.window.showWarningMessage('경로를 보낼 파일/폴더가 없습니다.');
		return;
	}
	const terminal = vscode.window.activeTerminal;
	if (!terminal) {
		vscode.window.showWarningMessage('활성 터미널이 없습니다. 에이전트가 떠 있는 터미널을 한 번 클릭한 뒤 다시 시도하세요.');
		return;
	}
	// 개행을 보내면 프롬프트가 제출되므로 경로만 입력해 둔다
	terminal.sendText(`${targets.map((target) => quoteIfNeeded(target.fsPath)).join(' ')} `, false);
	terminal.show(false);
}

// ===== 기능 5: 훅 설치/업데이트 =====

function installHooksCommand() {
	const summaries = [];
	let needsTrust = false;
	for (const target of companionHooks.installedTargets()) {
		let result;
		try {
			result = companionHooks.installCompanionHooks(target);
		} catch (error) {
			vscode.window.showErrorMessage(`${target.agent} 훅 설치 실패 — ${target.file} 확인 필요: ${error.message}`);
			continue;
		}
		const changed = [...result.added, ...result.updated];
		if (changed.length === 0) {
			continue;
		}
		const backup = result.backup ? `, 기존 파일 백업: ${path.basename(result.backup)}` : '';
		summaries.push(`${target.agent} (${changed.join(', ')}${backup})`);
		needsTrust = needsTrust || !!target.requiresTrust;
	}
	if (summaries.length === 0) {
		vscode.window.showInformationMessage('에이전트 훅이 이미 최신입니다.');
		return;
	}
	const trustNotice = needsTrust ? ' Codex는 /hooks에서 새 훅을 승인해야 동작합니다.' : '';
	vscode.window.showInformationMessage(
		`훅 설치 완료: ${summaries.join(' / ')} — 새로 시작하는 세션부터 적용됩니다.${trustNotice}`
	);
}

async function promptInstallHooksOnStartup() {
	if (!config().get('hooks.checkOnStartup', true)) {
		return;
	}
	const staleSummaries = [];
	for (const target of companionHooks.installedTargets()) {
		try {
			const stale = companionHooks.findStaleEvents(companionHooks.readSettings(target.file), target.specs);
			if (stale.length > 0) {
				staleSummaries.push(`${target.agent} (${stale.join(', ')})`);
			}
		} catch {
			// 설정 파일 파싱 실패 — 설치 커맨드를 직접 실행하면 에러가 안내된다
		}
	}
	if (staleSummaries.length === 0) {
		return;
	}
	const picked = await vscode.window.showInformationMessage(
		`Agent Companion 훅이 없거나 오래됐습니다: ${staleSummaries.join(' / ')}`,
		'설치/업데이트'
	);
	if (picked) {
		installHooksCommand();
	}
}

function activate(context) {
	agentStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	agentStatusItem.command = 'agentCompanion.sessions';
	context.subscriptions.push(agentStatusItem);

	const reconcileTimer = setInterval(reconcileAgentStates, RECONCILE_INTERVAL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(reconcileTimer) });

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal(handleTerminalFocus),

		vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
			if (terminal !== vscode.window.activeTerminal) {
				return;
			}
			if (pendingReveal.has(terminal)) {
				pendingReveal.delete(terminal);
				revealCwd(terminal);
				return;
			}
			// 같은 터미널 안에서 cd로 이동한 경우
			if (config().get('explorerSync.followCd', true)) {
				revealCwd(terminal);
			}
		}),

		// 창에 돌아왔을 때 15초 주기를 기다리지 않고 죽은 세션을 걷어낸다
		vscode.window.onDidChangeWindowState((windowState) => {
			if (windowState.focused) {
				reconcileAgentStates();
			}
		}),

		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_NS}.statusTracker.enabled`)) {
				updateAgentStatusBar();
			}
		}),

		vscode.commands.registerCommand('agentCompanion.addPathToAiChat', addPathToAiChat),
		vscode.commands.registerCommand('agentCompanion.sessions', agentSessionsQuickPick),
		vscode.commands.registerCommand('agentCompanion.installHooks', installHooksCommand)
	);

	for (const agent of AGENTS) {
		startCompanionEventWatcher(context, agent);
	}
	reconcileAgentStates();
	promptInstallHooksOnStartup();
	handleTerminalFocus(vscode.window.activeTerminal);
}

function deactivate() {}

module.exports = { activate, deactivate };
