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

// 에이전트별로 훅이 이벤트 파일을 쓰는 폴더가 달라서, 이벤트가 어느 폴더에서
// 왔는지로 에이전트를 판별한다 (훅 페이로드만으로는 구분되지 않음).
const AGENTS = [
	{ id: 'claude', label: 'Claude', processName: 'claude', eventsDir: path.join(os.homedir(), '.claude', 'companion-events') },
	{ id: 'codex', label: 'Codex', processName: 'codex', eventsDir: path.join(os.homedir(), '.codex', 'companion-events') }
];

// ============================================================
// 기능 1: 터미널-탐색기 동기화
// 터미널 포커스가 바뀌면 그 터미널의 작업 디렉토리를 탐색기에서 reveal + 펼침.
// ============================================================

// 직전에 reveal한 경로 — 같은 폴더를 반복해서 reveal하지 않기 위한 기억값
let lastRevealedPath;
// 포커스 시점에 셸 통합(cwd 조회)이 아직 준비되지 않았던 터미널들
const pendingReveal = new WeakSet();

function getTerminalCwd(terminal) {
	if (terminal.shellIntegration && terminal.shellIntegration.cwd) {
		return terminal.shellIntegration.cwd;
	}
	// 셸 통합이 아직 없으면 터미널 생성 시 지정된 cwd로 대체
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
	// 워크스페이스 바깥 경로는 탐색기 트리에 없으므로 무시
	if (!cwd || !vscode.workspace.getWorkspaceFolder(cwd)) {
		return;
	}
	if (cwd.toString() === lastRevealedPath) {
		return;
	}
	lastRevealedPath = cwd.toString();
	try {
		await vscode.commands.executeCommand('revealInExplorer', cwd);
		// reveal은 폴더를 선택만 하고 펼치지는 않으므로, 포커스된 항목을 펼침
		await vscode.commands.executeCommand('list.expand');
		// reveal이 탐색기로 포커스를 가져가므로 터미널로 되돌림
		if (vscode.window.activeTerminal === terminal) {
			terminal.show(false);
		}
	} catch {
		// reveal 실패(트리에서 찾을 수 없는 항목 등)는 조용히 무시
	}
}

function handleTerminalFocus(terminal) {
	if (!terminal) {
		return;
	}
	if (!(terminal.shellIntegration && terminal.shellIntegration.cwd)) {
		// 셸 통합이 활성화되면 onDidChangeTerminalShellIntegration에서 재시도
		pendingReveal.add(terminal);
	}
	revealCwd(terminal);
}

// ============================================================
// 기능 2: 응답 완료 / 입력 대기 알림
// 각 에이전트의 훅이 companion-events 폴더에 이벤트 파일을 떨구면 (훅
// 명세는 hooks.js), 이벤트의 cwd를 워크스페이스 폴더에 매핑해서 알림을
// 띄운다. 이벤트 종류는 페이로드의 hook_event_name으로 구분한다.
// Claude의 permission_prompt는 선택지 질문(AskUserQuestion)에도 발화하므로
// 문구는 "입력 대기"로 표현한다. 알림 클릭 시 해당 터미널로 이동.
// ============================================================

const EVENT_STATES = {
	UserPromptSubmit: 'working',
	PostToolUse: 'working',
	Notification: 'waiting', // Claude의 permission_prompt
	PermissionRequest: 'waiting', // Codex
	Stop: 'done'
};

// 같은 알림의 단시간 중복 발화를 막기 위한 기억값 (key → 마지막 표시 시각)
// 토스트가 떠 있는지 여부로 판단하면 안 된다 — 버튼이 있는 토스트는 사용자가
// 닫기 전까지 사라지지 않아서, 방치된 토스트 하나가 후속 알림을 전부 막는다.
const recentNotifications = new Map();
const NOTIFICATION_DEDUPE_MS = 3000;

// 알림 사운드 — VS Code API에는 토스트 사운드가 없어 OS 명령으로 재생한다.
// WSL에서는 리눅스 쪽 오디오 대신 Windows 시스템 알림음을 재생 (실측 ~1.8초 지연)
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
	exec(command, () => {}); // 플레이어가 없는 등 재생 실패는 조용히 무시
}

// argv[0]이 에이전트 실행 파일인 세션 프로세스인지 (/proc 조회, Linux/WSL 전용).
// Codex는 백그라운드에 `codex app-server` 데몬을 띄워 두는데, 데몬의 cwd가
// 프로젝트 폴더와 겹치면 세션이 살아있는 것으로 오판하므로 제외한다.
function isAgentProc(agent, pid) {
	try {
		const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
		return path.basename(argv[0] || '') === agent.processName && argv[1] !== 'app-server';
	} catch {
		return false; // 이미 종료됐거나 권한 없음
	}
}

function runningAgentProcs(agent) {
	const procs = [];
	let pids;
	try {
		pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
	} catch {
		return procs; // /proc 없는 플랫폼 — 실행 중 감지 생략
	}
	for (const pid of pids) {
		if (!isAgentProc(agent, pid)) {
			continue;
		}
		try {
			procs.push({ pid: Number(pid), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
		} catch {
			// 그 사이 종료됨
		}
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
			} catch {
				// 이미 닫힌 터미널
			}
		})
	);
	return pidToTerminal;
}

// 에이전트 PID에서 부모 체인을 타고 올라가 그 에이전트가 도는 터미널을 찾는다
// (조상 셸 pid == terminal.processId). Codex는 node 래퍼(codex.js)가 네이티브
// 바이너리를 띄우는 구조라 셸까지 한 단계 더 멀다.
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

// PID를 모를 때의 폴백: 해당 프로젝트(cwd)의 에이전트가 떠 있는 터미널을 추정한다.
// 워크스페이스 루트가 컨테이너 폴더(tools, k8s 등)여도 그 안의 프로젝트들을
// 구분할 수 있도록, 폴더가 아니라 cwd를 기준으로 매칭한다.
// 1순위: cwd가 일치하는 에이전트 프로세스의 터미널
// 2순위: 셸 cwd가 일치하는 터미널
// 3순위: 같은 워크스페이스 폴더에서 도는 에이전트의 터미널
// 4순위: 같은 워크스페이스 폴더의 아무 터미널
async function findTerminalForProject(agent, cwdPath, folder) {
	const terminals = vscode.window.terminals;
	const pidToTerminal = await buildPidToTerminalMap();
	const procs = runningAgentProcs(agent);
	for (const proc of procs) {
		if (proc.cwd === cwdPath) {
			const terminal = terminalOfAgentPid(proc.pid, pidToTerminal);
			if (terminal) {
				return terminal;
			}
		}
	}
	let sameFolderAgent;
	for (const proc of procs) {
		if (sameFolderAgent) {
			break;
		}
		const procFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(proc.cwd));
		if (procFolder && procFolder.uri.toString() === folder.uri.toString()) {
			sameFolderAgent = terminalOfAgentPid(proc.pid, pidToTerminal);
		}
	}
	let sameFolderTerminal;
	for (const terminal of terminals) {
		const cwd = getTerminalCwd(terminal);
		if (!cwd || cwd.scheme !== 'file') {
			continue;
		}
		if (cwd.fsPath === cwdPath) {
			return terminal;
		}
		const terminalFolder = vscode.workspace.getWorkspaceFolder(cwd);
		if (terminalFolder && terminalFolder.uri.toString() === folder.uri.toString() && !sameFolderTerminal) {
			sameFolderTerminal = terminal;
		}
	}
	return sameFolderAgent || sameFolderTerminal;
}

async function showTerminalForSession(agent, cwd, pid) {
	let terminal = pid ? terminalOfAgentPid(pid, await buildPidToTerminalMap()) : undefined;
	if (!terminal) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
		terminal = folder && (await findTerminalForProject(agent, cwd, folder));
	}
	if (terminal) {
		terminal.show();
	} else {
		vscode.window.showWarningMessage('해당 프로젝트의 터미널을 찾지 못했습니다.');
	}
}

// 이벤트 파일명: <나노초 타임스탬프>-<셸 pid>-<에이전트 pid>.json.
// $PPID가 세션 프로세스가 아니면(이미 종료, 데몬이 훅을 실행한 경우 등)
// 세션 식별에 쓸 수 없으므로 undefined — cwd로 폴백한다.
function agentPidFromEventFilename(agent, file) {
	const match = path.basename(file).match(/^\d+-\d+-(\d+)\.json$/);
	const pid = match && Number(match[1]);
	return pid && isAgentProc(agent, pid) ? pid : undefined;
}

// stateOnly: 시작 시 쌓여 있던 이벤트 처리용 — 상태 추적만 반영하고
// 뒤늦은 토스트/사운드는 내지 않는다.
async function handleCompanionEvent(agent, file, stateOnly = false) {
	let event;
	try {
		event = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return; // 아직 쓰이는 중이거나 깨진 파일
	}
	if (!event || typeof event.cwd !== 'string') {
		fs.unlink(file, () => {});
		return;
	}
	if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(event.cwd))) {
		return; // 이 창에 없는 프로젝트 — 해당 폴더가 열린 다른 창의 몫
	}
	// 이 창의 이벤트로 확정됐으므로 파일 제거 (다른 창의 뒤늦은 처리 방지)
	fs.unlink(file, () => {});

	const state = EVENT_STATES[event.hook_event_name];
	if (!state) {
		return;
	}
	// 상태 추적 반영 (기능 3) — 알림 설정과 독립적으로 항상 갱신
	const pid = agentPidFromEventFilename(agent, file);
	setAgentState(agent, event.cwd, state, pid);
	if (stateOnly) {
		return;
	}

	// 라벨은 폴더가 아니라 cwd 기준 — 워크스페이스 루트가 컨테이너
	// 폴더여도 그 안의 프로젝트를 정확히 가리키기 위함
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
	// 옵트인: 그 프로젝트의 터미널을 보고 있으면 알림 생략.
	// activeTerminal은 터미널 패널이 닫혀 있어도 존재하므로 오탐이 있어 기본 꺼짐.
	if (config().get('notifications.skipWhenViewing', false)) {
		const active = vscode.window.activeTerminal;
		if (vscode.window.state.focused && active) {
			const activeCwd = getTerminalCwd(active);
			if (activeCwd && activeCwd.fsPath === event.cwd) {
				return;
			}
		}
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
	// 설정 폴더(~/.codex 등)가 없으면 쓰지 않는 에이전트 — 만들어 버리면 훅
	// 설치 대상 판정(installedTargets)이 설치된 것으로 오판한다
	if (!fs.existsSync(path.dirname(agent.eventsDir))) {
		return;
	}
	try {
		fs.mkdirSync(agent.eventsDir, { recursive: true });
		// 창이 닫혀/리로드돼 있는 동안 쌓인 이벤트는 상태 추적에만 반영.
		// 파일명이 나노초 타임스탬프로 시작하므로 정렬 = 발생 순서.
		const leftovers = fs
			.readdirSync(agent.eventsDir)
			.filter((name) => name.endsWith('.json'))
			.sort();
		for (const name of leftovers) {
			handleCompanionEvent(agent, path.join(agent.eventsDir, name), true);
		}
		// 오래된 이벤트 파일 정리는 훅 커맨드의 find -mmin +60 -delete가 담당
		const watcher = fs.watch(agent.eventsDir, (_eventType, filename) => {
			// 훅이 .tmp에 쓴 뒤 .json으로 rename하므로, .json 등장 = 쓰기 완료
			if (filename && filename.endsWith('.json')) {
				handleCompanionEvent(agent, path.join(agent.eventsDir, filename));
			}
		});
		context.subscriptions.push({ dispose: () => watcher.close() });
	} catch (error) {
		console.warn(`agent-companion: ${agent.label} 이벤트 감시 시작 실패`, error);
	}
}

// ============================================================
// 기능 3: 세션별 에이전트 상태 추적
// 기능 2의 이벤트 파일을 재사용해서 세션별 상태를 상태바에 집계한다
// (매핑은 EVENT_STATES). 세션 식별은 에이전트 PID(훅이 이벤트 파일명에
// 실어줌) — 같은 폴더에서 여러 세션을 돌려도 각각 추적된다. PID를 쓸 수
// 없는 이벤트는 (에이전트, cwd)로 폴백. 프로세스가 사라진 항목은 /proc 스캔으로
// 주기적으로 걷어낸다. 상태바 클릭 → 세션 목록 QuickPick → 선택 시 해당
// 터미널로 이동. 토스트와 달리 입력을 처리하면 표시가 사라지므로, "놓친
// 토스트" 문제를 상시 표시로 보완하는 게 목적이다.
// ============================================================

// `${agent.id}:pid:${pid}` 또는 `${agent.id}:cwd:${cwd}` → { agent, cwd, pid?, kind, at }
const agentStates = new Map();
let agentStatusItem;

const STATE_ICONS = { waiting: '⏸️', done: '✅', working: '⏳' };
const STATE_LABELS = { waiting: '입력 대기', done: '응답 완료', working: '작업 중' };
// QuickPick/상태바 정렬: 내 손이 필요한 순서
const STATE_ORDER = { waiting: 0, done: 1, working: 2 };
const RECONCILE_INTERVAL_MS = 15000;

function setAgentState(agent, cwd, kind, pid) {
	if (!config().get('statusTracker.enabled', true)) {
		return;
	}
	const cwdKey = `${agent.id}:cwd:${cwd}`;
	if (pid) {
		// 같은 세션이 PID 없이 남긴 cwd 키 항목이 있으면 PID 키가 대체
		agentStates.delete(cwdKey);
	}
	agentStates.set(pid ? `${agent.id}:pid:${pid}` : cwdKey, { agent, cwd, pid, kind, at: Date.now() });
	updateAgentStatusBar();
}

// 에이전트 프로세스가 사라진(세션 종료/터미널 닫힘) 항목 제거
function reconcileAgentStates() {
	if (agentStates.size === 0) {
		return;
	}
	// /proc 없는 플랫폼(macOS 등)에서는 생존 판정 불가 — 전부 지우는 대신 유지
	if (!fs.existsSync('/proc')) {
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

// 같은 에이전트가 같은 폴더에서 여럿 돌면 이름만으로 구분이 안 되므로 pid를 병기
function stateTitler() {
	const nameCounts = new Map();
	const nameOf = (state) => `(${state.agent.label}) ${path.basename(state.cwd)}`;
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
	const parts = [];
	for (const kind of ['waiting', 'done', 'working']) {
		if (counts[kind] > 0) {
			parts.push(`${STATE_ICONS[kind]} ${counts[kind]}`);
		}
	}
	agentStatusItem.text = parts.join('  ');
	// 입력 대기가 있으면 경고색으로 눈에 띄게
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

// ============================================================
// 기능 4: Add Path to AI Chat
// 탐색기 우클릭 메뉴에서 선택한 파일/폴더의 절대 경로를 활성 터미널에
// 개행 없이 타이핑한다 — 에이전트 입력창에 경로가 입력된 상태가 됨.
// 활성 터미널로 보내므로 다른 프로젝트의 경로도 현재 채팅에 넣을 수 있다.
// ============================================================

function quoteIfNeeded(text) {
	return /\s/.test(text) ? `"${text}"` : text;
}

function addPathToAiChat(uri, uris) {
	let targets = Array.isArray(uris) && uris.length > 0 ? uris : uri ? [uri] : [];
	// 커맨드 팔레트에서 uri 없이 호출된 경우 활성 에디터 파일로 대체
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
	terminal.sendText(`${targets.map((target) => quoteIfNeeded(target.fsPath)).join(' ')} `, false);
	terminal.show(false);
}

// ============================================================
// 기능 5: 훅 자동 설치/업데이트
// 기능 2/3이 필요로 하는 훅(명세는 hooks.js)을 에이전트별 설정 파일에
// 설치한다. 시작 시 훅이 없거나 구버전이면 설치를 제안하고, "이 버전은
// 묻지 않음"은 HOOKS_VERSION 단위로 기억한다 (명세가 바뀌어 버전이 오르면
// 다시 안내).
// ============================================================

const HOOKS_DISMISS_KEY = 'hooksPromptDismissedVersion';

async function installHooksCommand(context) {
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
	// 설치를 실행했으니, 이후 명세 변경 시 다시 안내받도록 리셋
	await context.globalState.update(HOOKS_DISMISS_KEY, undefined);
	if (summaries.length === 0) {
		vscode.window.showInformationMessage('에이전트 훅이 이미 최신입니다.');
		return;
	}
	const trustNotice = needsTrust ? ' Codex는 /hooks에서 새 훅을 승인해야 동작합니다.' : '';
	vscode.window.showInformationMessage(
		`훅 설치 완료: ${summaries.join(' / ')} — 새로 시작하는 세션부터 적용됩니다.${trustNotice}`
	);
}

async function promptInstallHooksOnStartup(context) {
	if (!config().get('hooks.checkOnStartup', true)) {
		return;
	}
	if (context.globalState.get(HOOKS_DISMISS_KEY) === companionHooks.HOOKS_VERSION) {
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
			// 설정 파일 파싱 불가 — 커맨드로 직접 실행하면 에러가 안내됨
		}
	}
	if (staleSummaries.length === 0) {
		return;
	}
	const picked = await vscode.window.showInformationMessage(
		`Agent Companion 훅이 없거나 오래됐습니다: ${staleSummaries.join(' / ')}`,
		'설치/업데이트',
		'이 버전은 묻지 않음'
	);
	if (picked === '설치/업데이트') {
		await installHooksCommand(context);
	} else if (picked === '이 버전은 묻지 않음') {
		await context.globalState.update(HOOKS_DISMISS_KEY, companionHooks.HOOKS_VERSION);
	}
}

// ============================================================

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

		// 창에 돌아왔을 때 죽은 세션을 바로 걷어냄 (15초 주기를 기다리지 않도록)
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

		vscode.commands.registerCommand('agentCompanion.toggleExplorerSync', async () => {
			const current = config().get('explorerSync.enabled', true);
			await config().update('explorerSync.enabled', !current, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`터미널-탐색기 동기화: ${!current ? '켜짐' : '꺼짐'}`);
		}),

		vscode.commands.registerCommand('agentCompanion.addPathToAiChat', addPathToAiChat),
		vscode.commands.registerCommand('agentCompanion.sessions', agentSessionsQuickPick),
		vscode.commands.registerCommand('agentCompanion.installHooks', () => installHooksCommand(context))
	);

	for (const agent of AGENTS) {
		startCompanionEventWatcher(context, agent);
	}
	// 시작 스캔으로 복원된 상태 중 이미 죽은 세션을 즉시 걷어냄
	reconcileAgentStates();
	promptInstallHooksOnStartup(context);

	// 확장 로드 시점의 활성 터미널을 한 번 반영
	handleTerminalFocus(vscode.window.activeTerminal);
}

function deactivate() {}

module.exports = { activate, deactivate };
