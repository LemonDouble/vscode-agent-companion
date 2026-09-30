const fs = require('fs');
const os = require('os');
const path = require('path');

// 훅은 에이전트가 sh -c로 실행하므로 $PPID가 에이전트 PID다 (같은 폴더의 세션 구분용)
const eventsCommand = (eventsDir) =>
	`d="${eventsDir}"; mkdir -p "$d"; find "$d" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; f="$d/$(date +%s%N)-$$-$PPID"; cat > "$f.tmp" && mv "$f.tmp" "$f.json"`;

// 이 문자열을 포함한 훅 항목을 이 확장이 관리하는 항목으로 본다 (수동 설치한 훅 포함)
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
		// Codex는 훅 정의의 해시 단위로 신뢰(trust)를 기록해서, 명세가 바뀌면 /hooks에서 다시 승인해야 한다
		requiresTrust: true,
		specs: [
			{ event: 'Stop', command: CODEX_EVENTS },
			{ event: 'PermissionRequest', command: CODEX_EVENTS },
			{ event: 'UserPromptSubmit', command: CODEX_EVENTS },
			{ event: 'PostToolUse', command: CODEX_EVENTS }
		]
	}
];

function installedTargets() {
	return HOOK_TARGETS.filter((target) => fs.existsSync(target.configDir));
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

// 파싱 실패는 그대로 던진다 — 빈 설정으로 덮어써서 사용자 설정을 날리지 않도록
function readSettings(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return {};
	}
	return JSON.parse(raw);
}

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

// 사용자의 다른 훅은 순서까지 그대로 둔다
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
			continue;
		}
		const rest = entries.filter((entry) => !isCompanionEntry(entry));
		rest.splice(Math.min(firstIndex, rest.length), 0, specEntry(spec));
		hooks[spec.event] = rest;
		updated.push(spec.event);
	}
	return { added, updated };
}

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
	HOOK_TARGETS,
	installedTargets,
	readSettings,
	findStaleEvents,
	mergeCompanionHooks,
	installCompanionHooks
};
