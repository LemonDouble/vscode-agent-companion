# Agent Companion

Claude Code / Codex CLI로 여러 프로젝트를 동시에 진행할 때의 워크플로우를 돕는 VS Code 확장.

한 창에서 프로젝트별 터미널을 띄워놓고 작업하는 상황을 전제로 한다 — 큰 컨테이너 폴더(예: `~/claude-projects`)를 그대로 열고 터미널에서 각 레포로 `cd`해 들어가는 싱글 루트 구성과 멀티 루트 워크스페이스 둘 다 지원.

## 기능

### 1. 터미널-탐색기 동기화

터미널 포커스를 옮기면 탐색기(Explorer)가 해당 터미널의 작업 디렉토리로 자동 이동하고 해당 폴더를 펼친다.

- 활성 터미널이 바뀌면 (`onDidChangeActiveTerminal`) 셸 통합 API(`Terminal.shellIntegration.cwd`)로 그 터미널의 현재 작업 디렉토리를 조회해서 탐색기에서 reveal + 펼침
- 터미널 안에서 `cd`로 이동해도 따라감 (`explorerSync.followCd` 설정으로 끌 수 있음)
- 열려있는 에디터 탭은 건드리지 않음

VS Code에는 이 방향의 내장 기능이 없다 ([microsoft/vscode#71641](https://github.com/Microsoft/vscode/issues/71641), as-designed로 닫힘).

### 2. 응답 완료 / 입력 대기 알림

여러 터미널에서 에이전트를 돌릴 때, 어느 프로젝트의 에이전트가 **응답을 마쳤는지**(✅) 또는 **입력을 기다리며 멈춰 있는지**(⏸️) VS Code 알림으로 알려준다. 알림에는 에이전트가 표시된다 (예: `✅ (Codex) foo — 응답 완료`). "터미널로 이동" 버튼을 누르면 해당 세션의 터미널로 포커스가 이동한다.

동작 방식: 각 에이전트의 훅이 이벤트 파일을 `~/.claude/companion-events/`, `~/.codex/companion-events/`에 쓰고, 확장이 이 디렉토리를 감시한다. 이벤트 종류는 페이로드의 `hook_event_name`으로, 에이전트는 디렉토리로 구분한다.

| 상태 | Claude Code 훅 | Codex 훅 |
|---|---|---|
| ⏳ 작업 중 | `UserPromptSubmit`, `PostToolUse` | `UserPromptSubmit`, `PostToolUse` |
| ⏸️ 입력 대기 | `Notification` (`permission_prompt`) | `PermissionRequest` |
| ✅ 응답 완료 | `Stop` | `Stop` |

- 해당 프로젝트가 워크스페이스에 열려 있는 창에만 알림이 뜬다
- 프로젝트 식별은 워크스페이스 폴더가 아니라 **이벤트의 cwd** 기준 — 워크스페이스 루트가 컨테이너 폴더(`tools`, `k8s` 등)여도 그 안의 프로젝트를 정확히 구분한다
- "터미널로 이동"은 훅이 이벤트 파일명에 남긴 에이전트 PID(`$PPID`)에서 부모 셸 pid를 따라가 `terminal.processId`와 매칭한다 — 같은 폴더에 세션이 여러 개여도 해당 세션의 터미널로 이동한다
- Claude의 `permission_prompt`는 권한 승인뿐 아니라 선택지 질문(AskUserQuestion)에도 발화한다 (Claude Code 2.1.212 실측, 공식 문서에는 명시 없음)
- 알림이 뜰 때 사운드도 재생한다 (`notifications.sound.enabled`, 기본 켜짐) — WSL/Windows는 Windows 시스템 알림음, macOS는 `afplay`, Linux는 `paplay`
- `stopNotification.enabled` / `permissionNotification.enabled` 설정으로 각각 끌 수 있다
- `notifications.skipWhenViewing`을 켜면 해당 프로젝트 터미널을 보고 있을 때 알림을 생략한다 (터미널 패널이 닫혀 있어도 생략될 수 있는 오탐이 있어 기본 꺼짐)

한계:

- 입력을 이미 처리했어도 확장이 떠 있는 토스트를 닫을 방법은 없다 (VS Code API에 알림 닫기/지속시간 제어 없음). 토스트는 창이 포커스돼 있으면 약 10초 뒤 자동으로 닫히고(알림 센터에는 남음), 포커스가 없는 동안은 계속 떠 있는다 — 이를 보완하는 상시 표시는 기능 3 참고.
- Codex의 `PermissionRequest`는 Bash / apply_patch / MCP 도구 승인에만 발화한다 ([Codex hooks 문서](https://learn.chatgpt.com/docs/hooks)). Plan 모드의 선택지 질문(`request_user_input`)은 입력 대기로 잡히지 않는다.

**훅 필요** — [훅 설치](#훅-설치) 참고. 훅은 이벤트의 stdin JSON(cwd 포함)을 그대로 파일로 저장하며, 1시간 지난 이벤트 파일은 스스로 정리한다.

### 3. 세션별 에이전트 상태 추적

기능 2의 토스트는 놓치면 끝이다 — 입력 대기 중인 세션을 못 보면 그대로 방치된다. 이를 보완해서 상태바에 세션별 상태를 **상시 집계 표시**한다: `⏸️ 1  ✅ 1  ⏳ 2` (입력 대기 / 응답 완료 / 작업 중). 입력 대기가 하나라도 있으면 상태바 항목이 경고색으로 강조된다.

클릭하면 세션 목록이 뜨고(`⏸️ (Claude) foo`처럼 에이전트 표시, 내 손이 필요한 순서로 정렬, 경과 시간 표시), 선택하면 해당 세션의 터미널로 이동한다. 커맨드 팔레트 `Agent Companion: 에이전트 세션 상태`로도 열 수 있다.

- 상태 판정은 기능 2와 같은 이벤트 파일을 사용한다 (위 표 참고). `PostToolUse`가 있어야 권한 승인·질문 답변 후 작업 재개가 반영된다 (승인 자체에 대한 훅 이벤트는 없음 — 승인된 툴이 실행 완료되는 시점으로 갈음)
- 세션은 에이전트 PID로 구분한다 — 같은 폴더에서 여러 세션을 돌려도 각각 표시되고, 이름이 겹치면 `(pid 1234)`를 병기한다. PID를 쓸 수 없는 이벤트(훅을 실행한 프로세스가 세션 프로세스가 아닌 경우 등)는 에이전트 + cwd 단위로 폴백한다
- 에이전트 프로세스가 사라진 항목은 `/proc` 스캔으로 15초마다(+창 포커스 시) 자동 제거. Codex의 백그라운드 데몬(`codex app-server`)은 세션으로 치지 않는다

한계:

- 상태는 창(메모리)에만 있어서 창 리로드 직후에는 다음 이벤트가 올 때까지 비어 있다
- Esc로 응답을 중단한 경우 다음 이벤트까지 ⏳로 남는다 (Claude에는 중단 훅이 없고, Codex의 `Interrupt` 훅은 동작을 맞추기 위해 쓰지 않는다)
- `PostToolUse` 훅은 툴 호출마다 이벤트 파일을 하나 쓴다 (파일은 작고, 1시간 지난 파일은 훅이 스스로 정리) — 부담스러우면 이 훅만 빼도 된다. 승인 후 재개 반영만 늦어질 뿐 나머지는 동작한다.

### 4. Add Path to AI Chat

탐색기에서 파일/폴더를 우클릭하면 메뉴 최상단에 **Add Path to AI Chat**이 뜬다. 클릭하면 선택한 항목의 절대 경로가 활성 터미널(=에이전트 입력창)에 개행 없이 타이핑되고 포커스가 터미널로 이동한다 — 이어서 프롬프트를 계속 쓰면 된다.

- 다중 선택 지원 (공백으로 구분해서 한꺼번에 입력)
- 공백이 포함된 경로는 자동으로 따옴표 처리
- 활성 터미널로 보내므로, 프로젝트 A의 채팅에 프로젝트 B의 파일 경로를 넣는 것도 가능

## 훅 설치

알림(기능 2)·상태 추적(기능 3)은 에이전트 훅이 이벤트를 파일로 남겨줘야 동작한다. 커맨드 팔레트에서 **`Agent Companion: Claude Code/Codex 훅 설치/업데이트`** 를 실행하면 아래 파일에 훅 4개씩 자동으로 추가/갱신된다. 설정 폴더(`~/.claude`, `~/.codex`)가 없는 에이전트는 건너뛴다.

| 에이전트 | 설정 파일 | 훅 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Stop`, `Notification`(`permission_prompt`), `UserPromptSubmit`, `PostToolUse` |
| Codex | `~/.codex/hooks.json` | `Stop`, `PermissionRequest`, `UserPromptSubmit`, `PostToolUse` |

동작 방식:

- 변경 전 기존 파일을 `.bak`으로 백업하고, companion 훅이 아닌 사용자 훅은 순서 포함 그대로 보존한다
- "이 확장의 훅"은 커맨드 문자열의 `/companion-events` 경로 참조로 식별한다 — 수동 설치했던 훅도 관리 대상이 되고, 확장 업데이트로 훅 명세가 바뀌면 구버전 커맨드를 자동 교체한다 (직접 커스텀한 companion 훅도 표준 명세로 교체되니 주의)
- 확장 시작 시 훅이 없거나 구버전이면 설치를 제안한다 (`hooks.checkOnStartup` 설정으로 끌 수 있고, "이 버전은 묻지 않음"은 훅 명세 버전 단위로 기억된다)
- 훅 커맨드 원문은 [`hooks.js`](hooks.js)에 있다 — 원하면 수동 설치도 가능
- 훅 변경은 **새로 시작하는 세션부터** 적용된다
- **Codex는 훅을 신뢰(trust)해야 실행한다** — 설치/갱신 후 Codex에서 `/hooks`를 열어 승인해야 한다. 신뢰는 훅 정의의 해시 단위라 명세가 바뀌면 다시 승인해야 한다 ([Codex hooks 문서](https://learn.chatgpt.com/docs/hooks))

## 설치

[Releases](https://github.com/LemonDouble/vscode-agent-companion/releases)에서 vsix를 받거나, 직접 빌드한다:

```bash
npx --yes @vscode/vsce package
code --install-extension vscode-agent-companion-1.0.0.vsix
```

WSL 환경이라면 VS Code 통합 터미널(WSL)에서 실행해야 WSL 쪽에 설치된다.
UI로 설치하려면: 확장 탭 → `...` 메뉴 → "Install from VSIX...".

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `agentCompanion.explorerSync.enabled` | `true` | 터미널 포커스 시 탐색기 이동 |
| `agentCompanion.explorerSync.followCd` | `true` | 터미널 안에서 cd 할 때도 따라 이동 |
| `agentCompanion.stopNotification.enabled` | `true` | 응답 완료 시 알림 표시 |
| `agentCompanion.permissionNotification.enabled` | `true` | 입력 대기(질문/승인) 시 알림 표시 |
| `agentCompanion.notifications.skipWhenViewing` | `false` | 보고 있는 프로젝트의 알림 생략 (옵트인) |
| `agentCompanion.notifications.sound.enabled` | `true` | 알림 표시 시 사운드 재생 |
| `agentCompanion.statusTracker.enabled` | `true` | 상태바에 세션별 상태 집계 표시 |
| `agentCompanion.hooks.checkOnStartup` | `true` | 시작 시 훅 설치/최신 여부 확인 후 설치 제안 |

커맨드 팔레트에서 `Agent Companion: 터미널-탐색기 동기화 켜기/끄기`로 토글 가능.

## 요구사항

- VS Code 1.93 이상 (셸 통합 API)
- 터미널 셸 통합 활성화 (bash/zsh 등에서 기본 자동 주입, `terminal.integrated.shellIntegration.enabled`)
- 탐색기 동기화는 터미널의 cwd가 열린 워크스페이스 폴더 안에 있을 때만 동작
- 세션 생존 판정·터미널 매칭은 `/proc`를 사용하므로 Linux/WSL 전용 (다른 플랫폼에서는 cwd 기준 터미널 매칭으로 폴백)

## 함께 쓰면 좋은 워크스페이스 설정

```jsonc
{
	"settings": {
		// 터미널 탭 이름을 해당 터미널의 현재 폴더명으로 자동 표시
		"terminal.integrated.tabs.title": "${cwdFolder}",
		// 터미널 분할 시 어느 워크스페이스 폴더에서 열지 선택창 표시
		"terminal.integrated.splitCwd": "workspaceRoot"
	}
}
```
