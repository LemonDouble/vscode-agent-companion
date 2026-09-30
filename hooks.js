// Claude Code/Codex 훅 명세와 설치/점검 로직 — 이 확장이 필요로 하는 훅의
// 단일 진실 공급원. vscode 의존성이 없어서 node로 직접 테스트할 수 있다.
const fs = require('fs');
const os = require('os');
const path = require('path');

// 훅 명세를 바꾸면 반드시 올릴 것 — 시작 시 안내의 "이 버전은 묻지 않음"이
// 이 버전 단위로 동작해서, 명세가 바뀌면 다시 안내된다.
const HOOKS_VERSION = 3;

// 이벤트 stdin JSON을 에이전트별 companion-events에 저장 (+1시간 지난 파일 정리).
// 훅은 에이전트가 sh -c로 실행하므로 $PPID = 에이전트 프로세스 PID. 같은
// 폴더에서 여러 세션을 돌릴 때 cwd만으로는 구분되지 않아 파일명에 함께 남긴다.
const eventsCommand = (eventsDir) =>
	`d="${eventsDir}"; mkdir -p "$d"; find "$d" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; f="$d/$(date +%s%N)-$$-$PPID"; cat > "$f.tmp" && mv "$f.tmp" "$f.json"`;

// companion-events를 참조하는 훅 항목 = 이 확장이 관리하는 항목.
// 별도 마커 없이 경로 참조로 식별해서, 수동 설치된 기존 훅도 관리 대상이 된다.
const COMPANION_MARKER = '/companion-events';

const CLAUDE_EVENTS = eventsCommand('$HOME/.claude/companion-events');
const CODEX_EVENTS = eventsCommand('$HOME/.codex/companion-events');

const HOOK_TARGETS = [
	{
		agent: 'Claude Code',
		configDir: path.join(os.homedir(), '.claude'),
		file: path.join(os.homedir(), '.claude', 'settings.json'),
		specs: [
			{ event: 'Stop', command: CLAUDE_EVENTS },
			{ event: 'Notification', matcher: 'permission_prompt', command: CLAUDE_EVENTS },
			{ event: 'UserPromptSubmit', command: CLAUDE_EVENTS },
			{ event: 'PostToolUse', command: CLAUDE_EVENTS }
		]
	},
	{
		agent: 'Codex',
		configDir: path.join(os.homedir(), '.codex'),
		file: path.join(os.homedir(), '.codex', 'hooks.json'),
		// 신뢰(trust)는 훅 정의의 해시 단위라, 명세가 바뀌면 Codex의 /hooks에서 다시 승인해야 한다
		requiresTrust: true,
		specs: [
			{ event: 'Stop', command: CODEX_EVENTS },
			{ event: 'PermissionRequest', command: CODEX_EVENTS },
			{ event: 'UserPromptSubmit', command: CODEX_EVENTS },
			{ event: 'PostToolUse', command: CODEX_EVENTS }
		]
	}
];

// 설정 폴더가 없으면 그 에이전트를 쓰지 않는 환경으로 보고 건너뛴다
function installedTargets(targets = HOOK_TARGETS) {
	return targets.filter((target) => fs.existsSync(target.configDir));
}

function isCompanionEntry(entry) {
	return (
		!!entry &&
		Array.isArray(entry.hooks) &&
		entry.hooks.some(
			(hook) => hook && typeof hook.command === 'string' && hook.command.includes(COMPANION_MARKER)
		)
	);
}

function specEntry(spec) {
	const entry = {};
	if (spec.matcher) {
		entry.matcher = spec.matcher;
	}
	entry.hooks = [{ type: 'command', command: spec.command }];
	return entry;
}

function entryMatchesSpec(entry, spec) {
	return (
		(entry.matcher || undefined) === (spec.matcher || undefined) &&
		Array.isArray(entry.hooks) &&
		entry.hooks.length === 1 &&
		entry.hooks[0].type === 'command' &&
		entry.hooks[0].command === spec.command
	);
}

// 파일이 없으면 빈 설정으로 시작, 파싱 실패는 그대로 던짐 (덮어쓰기 방지)
function readSettings(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return {};
	}
	return JSON.parse(raw);
}

// 명세와 어긋나는(없거나, 구버전이거나, 중복인) 이벤트 목록
function findStaleEvents(settings, specs) {
	const hooks = (settings && settings.hooks) || {};
	const stale = [];
	for (const spec of specs) {
		const ours = (hooks[spec.event] || []).filter(isCompanionEntry);
		if (ours.length !== 1 || !entryMatchesSpec(ours[0], spec)) {
			stale.push(spec.event);
		}
	}
	return stale;
}

// settings 객체를 제자리에서 수정하고 변경 내역을 돌려준다.
// companion 항목이 아닌 훅(사용자의 다른 훅)은 순서 포함 그대로 보존.
function mergeCompanionHooks(settings, specs) {
	const hooks = settings.hooks || (settings.hooks = {});
	const added = [];
	const updated = [];
	for (const spec of specs) {
		const entries = hooks[spec.event] || (hooks[spec.event] = []);
		const firstIndex = entries.findIndex(isCompanionEntry);
		if (firstIndex === -1) {
			entries.push(specEntry(spec));
			added.push(spec.event);
			continue;
		}
		const ours = entries.filter(isCompanionEntry);
		if (ours.length === 1 && entryMatchesSpec(ours[0], spec)) {
			continue; // 이미 최신
		}
		// 첫 companion 항목 자리에 최신 명세를 넣고 중복은 제거
		const rest = entries.filter((entry) => !isCompanionEntry(entry));
		rest.splice(Math.min(firstIndex, rest.length), 0, specEntry(spec));
		hooks[spec.event] = rest;
		updated.push(spec.event);
	}
	return { added, updated };
}

// 훅을 설치/갱신하고 결과를 돌려준다. 변경이 없으면 파일을 건드리지 않는다.
function installCompanionHooks(target) {
	const settings = readSettings(target.file);
	const { added, updated } = mergeCompanionHooks(settings, target.specs);
	let backup;
	if (added.length > 0 || updated.length > 0) {
		if (fs.existsSync(target.file)) {
			backup = `${target.file}.bak`;
			fs.copyFileSync(target.file, backup);
		}
		fs.writeFileSync(target.file, `${JSON.stringify(settings, null, 2)}\n`);
	}
	return { added, updated, backup };
}

module.exports = {
	HOOKS_VERSION,
	HOOK_TARGETS,
	installedTargets,
	readSettings,
	findStaleEvents,
	mergeCompanionHooks,
	installCompanionHooks
};
