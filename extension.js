const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const companionHooks = require('./hooks');

const CONFIG_NS = 'claudeCodeCompanion';

function config() {
	return vscode.workspace.getConfiguration(CONFIG_NS);
}

// ============================================================
// 현재 프로젝트 추적
// 터미널 포커스/cwd 변경, 에디터 전환 중 가장 최근 이벤트를 기준으로
// "지금 작업 중인 프로젝트"를 기억한다. 프로젝트 = 워크스페이스 폴더가
// 아니라 cwd에서 유도한 프로젝트 루트(.git이 있는 가장 가까운 조상).
// 큰 컨테이너 폴더(~/claude-projects 등)를 그대로 열고 터미널에서 각
// 레포로 cd해 들어가는 워크플로우에서도 레포 단위로 한정되게 하기 위함.
// ============================================================

// { root: Uri(프로젝트 루트), folder: WorkspaceFolder(루트를 품은 워크스페이스 폴더) }
let currentProject;

// uri(파일/폴더)에서 프로젝트 루트를 유도: 위로 올라가며 .git이 있는
// 가장 가까운 조상. 워크스페이스 폴더 경계에서 멈추고, 못 찾으면 시작
// 폴더 자체로 폴백 (컨테이너 루트 전체로 번지는 것 방지).
function deriveProjectRoot(uri) {
	if (!uri || uri.scheme !== 'file') {
		return undefined;
	}
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return undefined;
	}
	let dir = uri.fsPath;
	try {
		if (!fs.statSync(dir).isDirectory()) {
			dir = path.dirname(dir);
		}
	} catch {
		dir = path.dirname(dir);
	}
	const top = folder.uri.fsPath;
	let cur = dir;
	for (;;) {
		// .git은 디렉토리(일반 레포) 또는 파일(worktree/서브모듈)일 수 있음
		if (fs.existsSync(path.join(cur, '.git'))) {
			return { root: vscode.Uri.file(cur), folder };
		}
		if (cur === top) {
			break;
		}
		const parent = path.dirname(cur);
		if (parent === cur) {
			break;
		}
		cur = parent;
	}
	return { root: vscode.Uri.file(dir), folder };
}

function setCurrentProject(uri) {
	const proj = deriveProjectRoot(uri);
	if (proj) {
		currentProject = proj;
		updateStatusBar();
	}
	return proj && proj.folder;
}

async function resolveProject() {
	if (currentProject) {
		return currentProject;
	}
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 0) {
		vscode.window.showWarningMessage('열린 워크스페이스 폴더가 없습니다.');
		return undefined;
	}
	if (folders.length === 1) {
		return { root: folders[0].uri, folder: folders[0] };
	}
	const picked = await vscode.window.showQuickPick(
		folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
		{ placeHolder: '프로젝트 선택' }
	);
	return picked && { root: picked.folder.uri, folder: picked.folder };
}

// ============================================================
// 상태 표시줄: 현재 프로젝트 표시 + 클릭 시 검색/파일 열기 메뉴
// ============================================================

let statusItem;

function updateStatusBar() {
	if (!statusItem) {
		return;
	}
	if (currentProject) {
		statusItem.text = `$(root-folder) ${path.basename(currentProject.root.fsPath)}`;
		statusItem.tooltip = `현재 프로젝트: ${currentProject.root.fsPath}\n클릭해서 검색/파일 열기`;
		statusItem.show();
	} else {
		statusItem.hide();
	}
}

// 워크스페이스 루트 하위의 git 레포를 얕게 스캔 (레포를 찾으면 그 안으로는
// 안 들어가고, 숨김 폴더/node_modules는 건너뜀)
function findGitRepos(dirPath, depth, out) {
	let entries;
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') {
			continue;
		}
		const p = path.join(dirPath, e.name);
		if (fs.existsSync(path.join(p, '.git'))) {
			out.push(p);
			continue;
		}
		if (depth > 1) {
			findGitRepos(p, depth - 1, out);
		}
	}
}

const REPO_SCAN_DEPTH = 3;

async function switchProject() {
	const folders = vscode.workspace.workspaceFolders || [];
	const items = [];
	for (const folder of folders) {
		items.push({
			label: `$(root-folder) ${folder.name}`,
			description: '루트 전체',
			root: folder.uri,
			folder
		});
		const repos = [];
		findGitRepos(folder.uri.fsPath, REPO_SCAN_DEPTH, repos);
		for (const p of repos.sort()) {
			items.push({
				label: `$(repo) ${path.relative(folder.uri.fsPath, p)}`,
				root: vscode.Uri.file(p),
				folder
			});
		}
	}
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: '현재 프로젝트로 지정할 폴더 선택 (하위 git 레포 자동 탐색)'
	});
	if (picked) {
		currentProject = { root: picked.root, folder: picked.folder };
		updateStatusBar();
	}
}

async function projectActions() {
	const proj = await resolveProject();
	if (!proj) {
		return;
	}
	const name = path.basename(proj.root.fsPath);
	const picked = await vscode.window.showQuickPick(
		[
			{ label: `$(search) ${name}에서 텍스트 검색`, action: findInProject },
			{ label: `$(go-to-file) ${name}에서 파일 열기`, action: openFileInProject },
			{ label: '$(folder-opened) 다른 프로젝트로 전환...', action: switchProject },
			{ label: '$(history) 최근 Claude 세션 복구 (모든 프로젝트)...', action: resumeRecentSessionCommand }
		],
		{ placeHolder: `현재 프로젝트: ${proj.root.fsPath}` }
	);
	if (picked) {
		await picked.action();
	}
}

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
	if (!terminal) {
		return;
	}
	const cwd = getTerminalCwd(terminal);
	if (!cwd) {
		return;
	}
	// 동기화가 꺼져 있어도 현재 프로젝트 추적은 유지
	const folder = setCurrentProject(cwd);
	// 워크스페이스 바깥 경로는 탐색기 트리에 없으므로 무시
	if (!folder || !config().get('explorerSync.enabled', true)) {
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
// 기능 2: 현재 프로젝트로 한정된 검색
// ============================================================

// 검색 뷰를 현재 프로젝트 루트로 스코프해서 연다 (완전한 한정)
async function findInProject() {
	const proj = await resolveProject();
	if (!proj) {
		return;
	}
	const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
	// 워크스페이스 루트 기준 상대 경로 ('' = 루트 자체가 프로젝트)
	const rel = path
		.relative(proj.folder.uri.fsPath, proj.root.fsPath)
		.split(path.sep)
		.filter(Boolean)
		.join('/');
	// ./상대/경로 는 검색을 그 폴더로 한정하는 문법. 멀티 루트에서는
	// ./루트폴더명 이 해당 루트 하나로 한정하므로 앞에 붙인다.
	let filesToInclude = '';
	if (multiRoot) {
		filesToInclude = rel ? `./${proj.folder.name}/${rel}` : `./${proj.folder.name}`;
	} else if (rel) {
		filesToInclude = `./${rel}`;
	}
	await vscode.commands.executeCommand('workbench.action.findInFiles', {
		filesToInclude,
		showIncludesExcludes: true,
		// 없으면 검색 뷰에 떠 있던 기존 결과가 새 스코프로 재실행되지 않아
		// 포함 칸만 바뀌고 결과는 전체 검색 그대로인 것처럼 보인다
		triggerSearch: true
	});
}

// files.exclude + search.exclude 를 합쳐 findFiles용 제외 glob 생성
function buildExcludeGlob(folder) {
	const patterns = new Set();
	for (const section of ['files', 'search']) {
		const excludes = vscode.workspace.getConfiguration(section, folder.uri).get('exclude') || {};
		for (const [pattern, active] of Object.entries(excludes)) {
			if (active) {
				patterns.add(pattern);
			}
		}
	}
	return patterns.size > 0 ? `{${[...patterns].join(',')}}` : undefined;
}

const MAX_FILES = 20000;

// 현재 프로젝트 루트의 파일만 QuickPick으로 보여준다 (Ctrl+P의 프로젝트 한정판)
async function openFileInProject() {
	const proj = await resolveProject();
	if (!proj) {
		return;
	}
	const name = path.basename(proj.root.fsPath);
	// RelativePattern은 WorkspaceFolder뿐 아니라 임의 Uri도 base로 받는다
	const files = await vscode.workspace.findFiles(
		new vscode.RelativePattern(proj.root, '**/*'),
		buildExcludeGlob(proj.folder),
		MAX_FILES
	);
	if (files.length === 0) {
		vscode.window.showInformationMessage(`${name} 안에서 파일을 찾지 못했습니다.`);
		return;
	}
	const items = files
		.map((uri) => {
			const rel = path.relative(proj.root.fsPath, uri.fsPath).split(path.sep).join('/');
			const slash = rel.lastIndexOf('/');
			return {
				label: slash >= 0 ? rel.slice(slash + 1) : rel,
				description: slash >= 0 ? rel.slice(0, slash) : '',
				uri
			};
		})
		.sort((a, b) => `${a.description}/${a.label}`.localeCompare(`${b.description}/${b.label}`));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `${name}에서 파일 열기${files.length >= MAX_FILES ? ` (상위 ${MAX_FILES}개만 표시)` : ''}`,
		matchOnDescription: true
	});
	if (picked) {
		await vscode.window.showTextDocument(picked.uri);
	}
}

// ============================================================
// 기능 3: Claude 응답 완료 / 입력 대기 알림
// Claude Code의 Stop 훅과 Notification 훅(permission_prompt)이
// ~/.claude/companion-events/ 에 이벤트 파일을 떨구면 (설치 방법은
// README 참고), 이벤트의 cwd를 워크스페이스 폴더에 매핑해서 알림을
// 띄운다. 이벤트 종류는 페이로드의 hook_event_name으로 구분한다.
// permission_prompt는 권한 승인뿐 아니라 선택지 질문(AskUserQuestion)
// 에도 발화하므로 문구는 "입력 대기"로 표현한다.
// 알림 클릭 시 해당 터미널로 이동.
// ============================================================

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'companion-events');

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
	let cmd;
	if (process.platform === 'win32' || isWSL) {
		cmd = `powershell.exe -NoProfile -Command "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify System Generic.wav').PlaySync()"`;
	} else if (process.platform === 'darwin') {
		cmd = 'afplay /System/Library/Sounds/Glass.aiff';
	} else {
		cmd = 'paplay /usr/share/sounds/freedesktop/stereo/message.oga';
	}
	exec(cmd, () => {}); // 플레이어가 없는 등 재생 실패는 조용히 무시
}

// 해당 프로젝트(cwd)의 claude가 떠 있는 터미널을 찾는다.
// 워크스페이스 루트가 컨테이너 폴더(tools, k8s 등)여도 그 안의 프로젝트들을
// 구분할 수 있도록, 폴더가 아니라 cwd를 기준으로 매칭한다.
// 1순위: cwd가 일치하는 claude 프로세스의 조상 셸 pid == terminal.processId
// 2순위: 셸 cwd가 일치하는 터미널
// 3순위: 같은 워크스페이스 폴더에서 도는 claude의 터미널
// 4순위: 같은 워크스페이스 폴더의 아무 터미널
async function findTerminalForProject(cwdPath, folder) {
	const terminals = vscode.window.terminals;
	const pidToTerminal = new Map();
	await Promise.all(
		terminals.map(async (t) => {
			try {
				const pid = await t.processId;
				if (pid) {
					pidToTerminal.set(pid, t);
				}
			} catch {
				// 이미 닫힌 터미널
			}
		})
	);
	const terminalOfClaude = (proc) => {
		let p = proc.pid;
		for (let depth = 0; depth < 5; depth++) {
			p = ppidOf(p);
			if (!p || p <= 1) {
				break;
			}
			const terminal = pidToTerminal.get(p);
			if (terminal) {
				return terminal;
			}
		}
		return undefined;
	};
	const procs = runningClaudeProcs();
	for (const proc of procs) {
		if (proc.cwd === cwdPath) {
			const terminal = terminalOfClaude(proc);
			if (terminal) {
				return terminal;
			}
		}
	}
	let sameFolderClaude;
	for (const proc of procs) {
		if (sameFolderClaude) {
			break;
		}
		const f = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(proc.cwd));
		if (f && f.uri.toString() === folder.uri.toString()) {
			sameFolderClaude = terminalOfClaude(proc);
		}
	}
	let sameFolderTerminal;
	for (const t of terminals) {
		const cwd = getTerminalCwd(t);
		if (!cwd || cwd.scheme !== 'file') {
			continue;
		}
		if (cwd.fsPath === cwdPath) {
			return t;
		}
		const f = vscode.workspace.getWorkspaceFolder(cwd);
		if (f && f.uri.toString() === folder.uri.toString() && !sameFolderTerminal) {
			sameFolderTerminal = t;
		}
	}
	return sameFolderClaude || sameFolderTerminal;
}

// stateOnly: 시작 시 쌓여 있던 이벤트 처리용 — 상태 추적만 반영하고
// 뒤늦은 토스트/사운드는 내지 않는다.
async function handleCompanionEvent(file, stateOnly = false) {
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
	const uri = vscode.Uri.file(event.cwd);
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return; // 이 창에 없는 프로젝트 — 해당 폴더가 열린 다른 창의 몫
	}
	// 이 창의 이벤트로 확정됐으므로 파일 제거 (다른 창의 뒤늦은 처리 방지)
	fs.unlink(file, () => {});

	// 라벨/매칭은 폴더가 아니라 cwd 기준 — 워크스페이스 루트가 컨테이너
	// 폴더여도 그 안의 프로젝트를 정확히 가리키기 위함
	const kind = event.hook_event_name;

	// 상태 추적 반영 (기능 6) — 알림 설정과 독립적으로 항상 갱신
	if (kind === 'UserPromptSubmit' || kind === 'PostToolUse') {
		setClaudeState(event.cwd, 'working');
	} else if (kind === 'Notification') {
		setClaudeState(event.cwd, 'waiting');
	} else if (kind === 'Stop') {
		setClaudeState(event.cwd, 'done');
	}
	if (stateOnly) {
		return;
	}

	const projectName = path.basename(event.cwd);
	let message;
	if (kind === 'Stop' && config().get('stopNotification.enabled', true)) {
		message = `✅ ${projectName} — Claude 응답 완료`;
	} else if (kind === 'Notification' && config().get('permissionNotification.enabled', true)) {
		message = `⏸️ ${projectName} — Claude가 입력을 기다립니다`;
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
	const key = `${kind}:${event.cwd}`;
	const now = Date.now();
	if (now - (recentNotifications.get(key) || 0) < NOTIFICATION_DEDUPE_MS) {
		return;
	}
	recentNotifications.set(key, now);
	playNotificationSound();
	const picked = await vscode.window.showInformationMessage(message, '터미널로 이동');
	if (picked === '터미널로 이동') {
		const terminal = await findTerminalForProject(event.cwd, folder);
		if (terminal) {
			terminal.show();
		} else {
			await vscode.commands.executeCommand('revealInExplorer', uri);
		}
	}
}

function startCompanionEventWatcher(context) {
	try {
		fs.mkdirSync(EVENTS_DIR, { recursive: true });
		// 창이 닫혀/리로드돼 있는 동안 쌓인 이벤트는 상태 추적에만 반영.
		// 파일명이 나노초 타임스탬프로 시작하므로 정렬 = 발생 순서.
		const leftovers = fs
			.readdirSync(EVENTS_DIR)
			.filter((n) => n.endsWith('.json'))
			.sort();
		for (const name of leftovers) {
			handleCompanionEvent(path.join(EVENTS_DIR, name), true);
		}
		// 오래된 이벤트 파일 정리는 훅 커맨드의 find -mmin +60 -delete가 담당
		const watcher = fs.watch(EVENTS_DIR, (_eventType, filename) => {
			// 훅이 .tmp에 쓴 뒤 .json으로 rename하므로, .json 등장 = 쓰기 완료
			if (filename && filename.endsWith('.json')) {
				handleCompanionEvent(path.join(EVENTS_DIR, filename));
			}
		});
		context.subscriptions.push({ dispose: () => watcher.close() });
	} catch (e) {
		console.warn('claude-code-companion: 이벤트 감시 시작 실패', e);
	}
}

// ============================================================
// 기능 4: Claude 세션 저장/복구
// SessionStart/SessionEnd 훅이 ~/.claude/companion-sessions/ 에 활성
// 세션을 기록한다 (설치 방법은 README 참고). VS Code가 통째로 꺼지면
// SessionEnd가 실행되지 못해 파일이 남고, 그 파일이 곧 복구 대상이다.
// 복구 = 해당 폴더에 터미널을 만들어 `claude --resume <session_id>` 실행.
// ============================================================

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'companion-sessions');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readSavedSessions() {
	let names;
	try {
		names = fs.readdirSync(SESSIONS_DIR);
	} catch {
		return [];
	}
	const sessions = [];
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		const file = path.join(SESSIONS_DIR, name);
		try {
			const mtime = fs.statSync(file).mtimeMs;
			if (Date.now() - mtime > SESSION_MAX_AGE_MS) {
				fs.unlinkSync(file); // 오래된 잔재 정리
				continue;
			}
			const data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (data && typeof data.cwd === 'string' && typeof data.session_id === 'string') {
				sessions.push({ file, cwd: data.cwd, sessionId: data.session_id, mtime });
			}
		} catch {
			// 깨진 파일/동시 삭제는 무시
		}
	}
	return sessions;
}

// argv[0]이 정확히 claude인 프로세스 목록 (/proc 스캔, Linux/WSL 전용)
function runningClaudeProcs() {
	const procs = [];
	let pids;
	try {
		pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
	} catch {
		return procs; // /proc 없는 플랫폼 — 실행 중 감지 생략
	}
	for (const pid of pids) {
		try {
			const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || '';
			if (path.basename(argv0) !== 'claude') {
				continue;
			}
			procs.push({ pid: Number(pid), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
		} catch {
			// 이미 종료됐거나 권한 없음
		}
	}
	return procs;
}

function ppidOf(pid) {
	try {
		const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m);
		return m ? Number(m[1]) : 0;
	} catch {
		return 0;
	}
}

// 이 창에서 복구 가능한 세션 목록: 프로젝트(cwd)당 최신 1개, 살아있는 세션 제외.
// 워크스페이스 폴더는 "이 창의 것인가" 판정에만 쓴다 — 루트가 컨테이너
// 폴더(tools 등)여도 그 안의 프로젝트별로 각각 복구되도록 cwd로 그룹핑.
// files에는 해당 cwd의 레지스트리 파일 전부를 담는다 (복구/무시 시 일괄 정리용).
function collectRestorableSessions() {
	const aliveCwds = new Set(runningClaudeProcs().map((p) => p.cwd));
	const byCwd = new Map();
	for (const s of readSavedSessions()) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(s.cwd));
		if (!folder) {
			continue; // 이 창의 프로젝트 아님
		}
		if (aliveCwds.has(s.cwd)) {
			continue; // 이미 돌고 있음 (창 리로드 직후 등) — 부활 금지
		}
		const entry = byCwd.get(s.cwd) || { files: [], latest: s };
		entry.files.push(s.file);
		if (s.mtime > entry.latest.mtime) {
			entry.latest = s;
		}
		byCwd.set(s.cwd, entry);
	}
	return [...byCwd.values()];
}

function discardSessionFiles(items) {
	for (const item of items) {
		for (const file of item.files) {
			try {
				fs.unlinkSync(file);
			} catch {
				// 다른 창이 먼저 지웠으면 무시
			}
		}
	}
}

function launchClaudeResume(cwd, sessionId) {
	const claudeCmd = config().get('sessionRestore.claudeCommand', 'claude');
	const terminal = vscode.window.createTerminal({
		name: path.basename(cwd),
		cwd: vscode.Uri.file(cwd)
	});
	terminal.show(true);
	terminal.sendText(`${claudeCmd} --resume ${sessionId}`);
}

function launchRestoredSessions(items) {
	for (const item of items) {
		launchClaudeResume(item.latest.cwd, item.latest.sessionId);
	}
	discardSessionFiles(items);
}

async function restoreSessionsCommand() {
	const items = collectRestorableSessions();
	if (items.length === 0) {
		vscode.window.showInformationMessage('복구할 Claude 세션이 없습니다.');
		return;
	}
	launchRestoredSessions(items);
}

async function promptRestoreOnStartup() {
	if (!config().get('sessionRestore.enabled', true)) {
		return;
	}
	const items = collectRestorableSessions();
	if (items.length === 0) {
		return;
	}
	const names = items.map((i) => path.basename(i.latest.cwd)).join(', ');
	const picked = await vscode.window.showInformationMessage(
		`이전 Claude 세션 발견: ${names}`,
		'복구',
		'무시'
	);
	if (picked === '복구') {
		launchRestoredSessions(items);
	} else if (picked === '무시') {
		discardSessionFiles(items);
	}
}

// 사용자가 터미널을 직접 닫으면(휴지통/kill) claude는 그냥 kill돼서
// SessionEnd가 삭제 사유(clear 등)로 실행되지 못하고 파일이 남는다 —
// 크래시와 똑같은 흔적이라 다음 시작 때 복구 프롬프트가 뜬다.
// 크래시와 달리 이 경우는 익스텐션이 살아서 닫힘 이벤트를 받으므로,
// 여기서 파일을 지워 의도적으로 닫은 세션은 복구 대상에서 뺀다.
// 닫힌 터미널이 어떤 세션이었는지는 이 시점엔 알 수 없어(프로세스가
// 이미 죽어 /proc에 없음) 소거법으로 추정한다: 이 창 소속인데 살아있는
// claude가 없는 세션 파일 전부. 응답 없이 닫힌 복구 프롬프트의 잔재가
// 같이 지워질 수 있지만, 단순함의 대가로 감수한다.
const USER_CLOSE_CLEANUP_DELAY_MS = 2000;

function handleTerminalClose(terminal) {
	if (!terminal.exitStatus || terminal.exitStatus.reason !== vscode.TerminalExitReason.User) {
		return;
	}
	// SIGHUP을 받은 claude가 실제로 죽고 SessionStart 파일만 남기까지 대기.
	// 이 안에 안 죽으면 정리를 놓치지만, 다음 시작 때 프롬프트가 한 번 더
	// 뜨는 것뿐이라 (기존 동작과 동일) 재시도는 하지 않는다.
	setTimeout(() => {
		const aliveCwds = new Set(runningClaudeProcs().map((p) => p.cwd));
		for (const s of readSavedSessions()) {
			if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(s.cwd))) {
				continue; // 이 창의 프로젝트 아님
			}
			if (aliveCwds.has(s.cwd)) {
				continue; // 다른 터미널/워크트리에서 아직 돌고 있음
			}
			try {
				fs.unlinkSync(s.file);
			} catch {
				// 다른 창이 먼저 지웠으면 무시
			}
		}
	}, USER_CLOSE_CLEANUP_DELAY_MS);
}

// ============================================================
// 기능 5: Add to Claude Path
// 탐색기 우클릭 메뉴에서 선택한 파일/폴더의 절대 경로를 활성 터미널에
// 개행 없이 타이핑한다 — Claude Code 입력창에 경로가 입력된 상태가 됨.
// 활성 터미널로 보내므로 다른 프로젝트의 경로도 현재 채팅에 넣을 수 있다.
// 변형: 에디터 선택 영역(경로#L10-L25), 현재 파일의 진단(에러/경고).
// ============================================================

function sendTextToActiveTerminal(text) {
	const terminal = vscode.window.activeTerminal;
	if (!terminal) {
		vscode.window.showWarningMessage('활성 터미널이 없습니다. Claude가 떠 있는 터미널을 한 번 클릭한 뒤 다시 시도하세요.');
		return;
	}
	terminal.sendText(`${text} `, false);
	terminal.show(false);
}

function quoteIfNeeded(s) {
	return /\s/.test(s) ? `"${s}"` : s;
}

function addToClaudePath(uri, uris) {
	let targets = Array.isArray(uris) && uris.length > 0 ? uris : uri ? [uri] : [];
	// 커맨드 팔레트에서 uri 없이 호출된 경우 활성 에디터 파일로 대체
	if (targets.length === 0 && vscode.window.activeTextEditor) {
		targets = [vscode.window.activeTextEditor.document.uri];
	}
	targets = targets.filter((u) => u && u.scheme === 'file');
	if (targets.length === 0) {
		vscode.window.showWarningMessage('경로를 보낼 파일/폴더가 없습니다.');
		return;
	}
	sendTextToActiveTerminal(targets.map((u) => quoteIfNeeded(u.fsPath)).join(' '));
}

// 선택 영역 → "경로#L10-L25" 참조 (1-indexed). 선택 끝이 어느 라인의 첫
// 칸이면 그 라인은 실제로 선택된 게 아니므로 제외한다 (라인 드래그 선택).
function selectionRef(fsPath, sel) {
	const startLine = sel.start.line + 1;
	let endLine = sel.end.line + 1;
	if (endLine > startLine && sel.end.character === 0) {
		endLine--;
	}
	const suffix = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
	return quoteIfNeeded(`${fsPath}${suffix}`);
}

function addSelectionToClaudePath() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') {
		vscode.window.showWarningMessage('선택 영역을 보낼 파일 에디터가 없습니다.');
		return;
	}
	const fsPath = editor.document.uri.fsPath;
	// 다중 커서 선택 지원. 선택이 하나도 없으면 커서 라인을 참조로.
	let sels = editor.selections.filter((s) => !s.isEmpty);
	if (sels.length === 0) {
		sels = [editor.selection];
	}
	sendTextToActiveTerminal(sels.map((s) => selectionRef(fsPath, s)).join(' '));
}

const DIAG_SEVERITY_NAMES = ['Error', 'Warning', 'Info', 'Hint'];
const MAX_DIAGNOSTICS = 10;

// 진단 목록 → 한 줄 텍스트. 터미널에서 개행 = 프롬프트 제출이라
// 여러 진단을 "; "로 이어붙인다. 심각한 것부터 최대 10개.
function formatDiagnostics(fsPath, diags) {
	const sorted = [...diags].sort(
		(a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line
	);
	const parts = sorted.slice(0, MAX_DIAGNOSTICS).map((d) => {
		const sev = DIAG_SEVERITY_NAMES[d.severity] || 'Info';
		const msg = String(d.message).replace(/\s+/g, ' ').trim();
		const src = d.source ? ` (${d.source})` : '';
		return `${fsPath}#L${d.range.start.line + 1} [${sev}] ${msg}${src}`;
	});
	let text = parts.join('; ');
	if (sorted.length > MAX_DIAGNOSTICS) {
		text += ` (외 ${sorted.length - MAX_DIAGNOSTICS}개)`;
	}
	return text;
}

function addDiagnosticsToClaude() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') {
		vscode.window.showWarningMessage('진단을 보낼 파일 에디터가 없습니다.');
		return;
	}
	let diags = vscode.languages.getDiagnostics(editor.document.uri);
	// 선택 영역이 있으면 그 범위와 겹치는 진단만
	if (!editor.selection.isEmpty) {
		diags = diags.filter((d) => d.range.intersection(editor.selection));
	}
	if (diags.length === 0) {
		vscode.window.showInformationMessage('보낼 진단이 없습니다.');
		return;
	}
	sendTextToActiveTerminal(formatDiagnostics(editor.document.uri.fsPath, diags));
}

// ============================================================
// 기능 6: 프로젝트별 Claude 상태 추적
// 기능 3의 이벤트 파일을 재사용해서 프로젝트(cwd)별 Claude 상태를
// 상태바에 집계한다. UserPromptSubmit/PostToolUse 훅이 추가로 필요
// (설치 방법은 README 참고).
//   UserPromptSubmit / PostToolUse → ⏳ 작업 중
//   Notification(permission_prompt) → ⏸️ 입력 대기
//   Stop → ✅ 응답 완료
// 프로세스가 사라진 항목은 /proc 스캔으로 주기적으로 걷어낸다.
// 상태바 클릭 → 세션 목록 QuickPick → 선택 시 해당 터미널로 이동.
// 토스트와 달리 입력을 처리하면 표시가 사라지므로, "놓친 토스트" 문제를
// 상시 표시로 보완하는 게 목적이다.
// ============================================================

const claudeStates = new Map(); // cwd → { kind: 'working'|'waiting'|'done', at: ms }
let claudeStatusItem;

const STATE_ICONS = { waiting: '⏸️', done: '✅', working: '⏳' };
const STATE_LABELS = { waiting: '입력 대기', done: '응답 완료', working: '작업 중' };
// QuickPick/상태바 정렬: 내 손이 필요한 순서
const STATE_ORDER = { waiting: 0, done: 1, working: 2 };
const RECONCILE_INTERVAL_MS = 15000;

function setClaudeState(cwd, kind) {
	if (!config().get('statusTracker.enabled', true)) {
		return;
	}
	claudeStates.set(cwd, { kind, at: Date.now() });
	updateClaudeStatusBar();
}

// claude 프로세스가 사라진(세션 종료/터미널 닫힘) 항목 제거
function reconcileClaudeStates() {
	if (claudeStates.size === 0) {
		return;
	}
	// /proc 없는 플랫폼(macOS 등)에서는 생존 판정 불가 — 전부 지우는 대신 유지
	if (!fs.existsSync('/proc')) {
		return;
	}
	const alive = new Set(runningClaudeProcs().map((p) => p.cwd));
	let changed = false;
	for (const cwd of [...claudeStates.keys()]) {
		if (!alive.has(cwd)) {
			claudeStates.delete(cwd);
			changed = true;
		}
	}
	if (changed) {
		updateClaudeStatusBar();
	}
}

function updateClaudeStatusBar() {
	if (!claudeStatusItem) {
		return;
	}
	if (claudeStates.size === 0 || !config().get('statusTracker.enabled', true)) {
		claudeStatusItem.hide();
		return;
	}
	const counts = { waiting: 0, done: 0, working: 0 };
	for (const s of claudeStates.values()) {
		counts[s.kind]++;
	}
	const parts = [];
	for (const kind of ['waiting', 'done', 'working']) {
		if (counts[kind] > 0) {
			parts.push(`${STATE_ICONS[kind]} ${counts[kind]}`);
		}
	}
	claudeStatusItem.text = parts.join('  ');
	// 입력 대기가 있으면 경고색으로 눈에 띄게
	claudeStatusItem.backgroundColor =
		counts.waiting > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
	claudeStatusItem.tooltip = [
		'Claude 세션 상태 — 클릭해서 터미널로 이동',
		...[...claudeStates.entries()].map(
			([cwd, s]) => `${STATE_ICONS[s.kind]} ${path.basename(cwd)} — ${STATE_LABELS[s.kind]}`
		)
	].join('\n');
	claudeStatusItem.show();
}

function formatElapsed(ms) {
	const min = Math.floor(ms / 60000);
	if (min < 1) {
		return '방금 전';
	}
	if (min < 60) {
		return `${min}분 경과`;
	}
	return `${Math.floor(min / 60)}시간 ${min % 60}분 경과`;
}

async function claudeSessionsQuickPick() {
	reconcileClaudeStates();
	if (claudeStates.size === 0) {
		vscode.window.showInformationMessage('추적 중인 Claude 세션이 없습니다.');
		return;
	}
	const items = [...claudeStates.entries()]
		.sort((a, b) => STATE_ORDER[a[1].kind] - STATE_ORDER[b[1].kind] || a[1].at - b[1].at)
		.map(([cwd, s]) => ({
			label: `${STATE_ICONS[s.kind]} ${path.basename(cwd)}`,
			description: `${STATE_LABELS[s.kind]} · ${formatElapsed(Date.now() - s.at)}`,
			detail: cwd,
			cwd
		}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Claude 세션 — 선택하면 해당 터미널로 이동'
	});
	if (!picked) {
		return;
	}
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(picked.cwd));
	const terminal = folder && (await findTerminalForProject(picked.cwd, folder));
	if (terminal) {
		terminal.show();
	} else {
		vscode.window.showWarningMessage('해당 프로젝트의 터미널을 찾지 못했습니다.');
	}
}

// ============================================================
// 기능 7: 훅 자동 설치/업데이트
// 기능 3/4/6이 필요로 하는 Claude Code 훅(명세는 hooks.js)을
// ~/.claude/settings.json에 설치한다. 시작 시 훅이 없거나 구버전이면
// 설치를 제안하고, "이 버전은 묻지 않음"은 HOOKS_VERSION 단위로 기억한다
// (명세가 바뀌어 버전이 오르면 다시 안내).
// ============================================================

const HOOKS_DISMISS_KEY = 'hooksPromptDismissedVersion';

async function installHooksCommand(context) {
	let result;
	try {
		result = companionHooks.installCompanionHooks();
	} catch (e) {
		vscode.window.showErrorMessage(
			`Claude Code 훅 설치 실패 — ${companionHooks.SETTINGS_FILE} 확인 필요: ${e.message}`
		);
		return;
	}
	// 설치를 실행했으니, 이후 명세 변경 시 다시 안내받도록 리셋
	await context.globalState.update(HOOKS_DISMISS_KEY, undefined);
	if (result.added.length === 0 && result.updated.length === 0) {
		vscode.window.showInformationMessage('Claude Code 훅이 이미 최신입니다.');
		return;
	}
	const parts = [];
	if (result.added.length > 0) {
		parts.push(`추가 ${result.added.length}개 (${result.added.join(', ')})`);
	}
	if (result.updated.length > 0) {
		parts.push(`갱신 ${result.updated.length}개 (${result.updated.join(', ')})`);
	}
	vscode.window.showInformationMessage(
		`Claude Code 훅 설치 완료: ${parts.join(', ')} — 새로 시작하는 claude 세션부터 적용됩니다.${result.backup ? ' (기존 설정 백업: settings.json.bak)' : ''}`
	);
}

async function promptInstallHooksOnStartup(context) {
	if (!config().get('hooks.checkOnStartup', true)) {
		return;
	}
	if (context.globalState.get(HOOKS_DISMISS_KEY) === companionHooks.HOOKS_VERSION) {
		return;
	}
	let stale;
	try {
		stale = companionHooks.findStaleEvents(companionHooks.readSettings());
	} catch {
		return; // settings.json 파싱 불가 — 커맨드로 직접 실행하면 에러가 안내됨
	}
	if (stale.length === 0) {
		return;
	}
	const picked = await vscode.window.showInformationMessage(
		`Claude Code Companion 훅이 없거나 오래됐습니다: ${stale.join(', ')}`,
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
// 기능 8: 최근 세션 전체 조회/복구
// Claude Code가 직접 남기는 대화 기록(~/.claude/projects/<인코딩된 경로>/
// <session_id>.jsonl — 파일명이 곧 세션 id, --resume 시 같은 파일에 이어
// 씀)을 읽어, 워크스페이스와 무관하게 최근 세션을 최신순으로 보여주고
// 선택하면 해당 폴더 터미널에서 --resume 한다. 훅 불필요.
// ============================================================

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const RECENT_SESSIONS_LIMIT = 30;
// 첫 프롬프트는 보통 파일 첫머리에 있다 — 전체 파싱 대신 앞부분만 읽음
const SESSION_HEAD_BYTES = 256 * 1024;

function listRecentSessionFiles(limit) {
	let projectDirNames;
	try {
		projectDirNames = fs.readdirSync(CLAUDE_PROJECTS_DIR);
	} catch {
		return [];
	}
	const files = [];
	for (const dirName of projectDirNames) {
		let names;
		try {
			names = fs.readdirSync(path.join(CLAUDE_PROJECTS_DIR, dirName));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith('.jsonl')) {
				continue;
			}
			const file = path.join(CLAUDE_PROJECTS_DIR, dirName, name);
			try {
				const stat = fs.statSync(file);
				if (stat.isFile()) {
					files.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs });
				}
			} catch {
				// 동시 삭제 등은 무시
			}
		}
	}
	return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// 세션 기록의 user 항목에서 사람이 쓴 프롬프트 텍스트를 뽑는다.
// 슬래시 커맨드 기록(<command-name>...)과 툴 결과(content 배열의
// tool_result)는 제외.
function userPromptText(message) {
	if (!message || message.role !== 'user') {
		return undefined;
	}
	let text;
	if (typeof message.content === 'string') {
		text = message.content;
	} else if (Array.isArray(message.content)) {
		const part = message.content.find((p) => p && p.type === 'text' && typeof p.text === 'string');
		text = part && part.text;
	}
	if (!text || text.startsWith('<command-name>') || text.startsWith('<local-command')) {
		return undefined;
	}
	return text.replace(/\s+/g, ' ').trim();
}

// 세션 파일 앞부분에서 cwd와 첫 사용자 프롬프트를 뽑는다.
// 프롬프트가 하나도 없는 세션(열자마자 닫은 빈 세션)은 undefined.
function readSessionSummary(file) {
	let head;
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const buf = Buffer.alloc(SESSION_HEAD_BYTES);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.toString('utf8', 0, n);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	let cwd;
	let prompt;
	for (const line of head.split('\n')) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 읽기 범위에서 잘린 마지막 줄 등
		}
		if (!cwd && typeof entry.cwd === 'string') {
			cwd = entry.cwd;
		}
		if (!prompt && entry.type === 'user' && !entry.isMeta) {
			prompt = userPromptText(entry.message);
		}
		if (cwd && prompt) {
			break;
		}
	}
	return cwd && prompt ? { cwd, prompt } : undefined;
}

function formatAgo(ms) {
	const min = Math.floor(ms / 60000);
	if (min < 1) {
		return '방금 전';
	}
	if (min < 60) {
		return `${min}분 전`;
	}
	const hours = Math.floor(min / 60);
	if (hours < 24) {
		return `${hours}시간 전`;
	}
	return `${Math.floor(hours / 24)}일 전`;
}

const PROMPT_PREVIEW_LENGTH = 100;

function buildRecentSessionItems(limit) {
	const home = os.homedir();
	const aliveCwds = new Set(runningClaudeProcs().map((p) => p.cwd));
	const items = [];
	for (const f of listRecentSessionFiles(limit)) {
		const info = readSessionSummary(f.file);
		if (!info || !fs.existsSync(info.cwd)) {
			continue; // 빈 세션이거나 폴더가 삭제된 프로젝트
		}
		const shortPath = info.cwd.startsWith(home) ? `~${info.cwd.slice(home.length)}` : info.cwd;
		const running = aliveCwds.has(info.cwd) ? ' · ⚠️ 이 폴더에 실행 중인 claude 있음' : '';
		items.push({
			label: `$(history) ${path.basename(info.cwd)}`,
			description: `${formatAgo(Date.now() - f.mtime)} · ${shortPath}${running}`,
			detail: info.prompt.slice(0, PROMPT_PREVIEW_LENGTH),
			cwd: info.cwd,
			sessionId: f.sessionId
		});
	}
	return items;
}

async function resumeRecentSessionCommand() {
	const items = buildRecentSessionItems(RECENT_SESSIONS_LIMIT);
	if (items.length === 0) {
		vscode.window.showInformationMessage('최근 Claude 세션 기록이 없습니다.');
		return;
	}
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: '최근 Claude 세션 (모든 프로젝트) — 선택하면 해당 폴더 터미널에서 복구',
		matchOnDescription: true,
		matchOnDetail: true
	});
	if (picked) {
		launchClaudeResume(picked.cwd, picked.sessionId);
	}
}

// ============================================================

function activate(context) {
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusItem.command = 'claudeCodeCompanion.projectActions';
	context.subscriptions.push(statusItem);

	claudeStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	claudeStatusItem.command = 'claudeCodeCompanion.claudeSessions';
	context.subscriptions.push(claudeStatusItem);

	const reconcileTimer = setInterval(reconcileClaudeStates, RECONCILE_INTERVAL_MS);
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

		// 에디터 전환도 "현재 프로젝트" 판단에 반영
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.uri.scheme === 'file') {
				setCurrentProject(editor.document.uri);
			}
		}),

		// 창에 돌아왔을 때 죽은 세션을 바로 걷어냄 (15초 주기를 기다리지 않도록)
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) {
				reconcileClaudeStates();
			}
		}),

		// 휴지통 등으로 사용자가 닫은 터미널의 세션 기록 정리 (기능 4)
		vscode.window.onDidCloseTerminal(handleTerminalClose),

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${CONFIG_NS}.statusTracker.enabled`)) {
				updateClaudeStatusBar();
			}
		}),

		vscode.commands.registerCommand('claudeCodeCompanion.toggleExplorerSync', async () => {
			const current = config().get('explorerSync.enabled', true);
			await config().update('explorerSync.enabled', !current, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`터미널-탐색기 동기화: ${!current ? '켜짐' : '꺼짐'}`);
		}),

		vscode.commands.registerCommand('claudeCodeCompanion.findInProject', findInProject),
		vscode.commands.registerCommand('claudeCodeCompanion.openFileInProject', openFileInProject),
		vscode.commands.registerCommand('claudeCodeCompanion.projectActions', projectActions),
		vscode.commands.registerCommand('claudeCodeCompanion.restoreSessions', restoreSessionsCommand),
		vscode.commands.registerCommand('claudeCodeCompanion.resumeRecentSession', resumeRecentSessionCommand),
		vscode.commands.registerCommand('claudeCodeCompanion.addToClaudePath', addToClaudePath),
		vscode.commands.registerCommand('claudeCodeCompanion.addSelectionToClaudePath', addSelectionToClaudePath),
		vscode.commands.registerCommand('claudeCodeCompanion.addDiagnosticsToClaude', addDiagnosticsToClaude),
		vscode.commands.registerCommand('claudeCodeCompanion.claudeSessions', claudeSessionsQuickPick),
		vscode.commands.registerCommand('claudeCodeCompanion.installHooks', () => installHooksCommand(context))
	);

	startCompanionEventWatcher(context);
	// 시작 스캔으로 복원된 상태 중 이미 죽은 세션을 즉시 걷어냄
	reconcileClaudeStates();
	promptRestoreOnStartup();
	promptInstallHooksOnStartup(context);

	// 확장 로드 시점의 활성 터미널/에디터를 한 번 반영
	handleTerminalFocus(vscode.window.activeTerminal);
	if (vscode.window.activeTextEditor) {
		setCurrentProject(vscode.window.activeTextEditor.document.uri);
	}
}

function deactivate() {}

module.exports = {
	activate,
	deactivate,
	_test: {
		deriveProjectRoot,
		findGitRepos,
		selectionRef,
		formatDiagnostics,
		handleTerminalClose,
		listRecentSessionFiles,
		readSessionSummary,
		userPromptText,
		formatAgo,
		buildRecentSessionItems
	}
};
