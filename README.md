# Claude Code Companion

Claude Code CLI로 여러 프로젝트를 동시에 진행할 때의 워크플로우를 돕는 VS Code 확장.

한 창에서 프로젝트별 터미널을 띄워놓고 작업하는 상황을 전제로 한다 — 큰 컨테이너 폴더(예: `~/claude-projects`)를 그대로 열고 터미널에서 각 레포로 `cd`해 들어가는 싱글 루트 구성과 멀티 루트 워크스페이스 둘 다 지원. 기능은 계속 추가될 예정.

## 기능

### 1. 터미널-탐색기 동기화

터미널 포커스를 옮기면 탐색기(Explorer)가 해당 터미널의 작업 디렉토리로 자동 이동하고 해당 폴더를 펼친다.

- 활성 터미널이 바뀌면 (`onDidChangeActiveTerminal`) 셸 통합 API(`Terminal.shellIntegration.cwd`)로 그 터미널의 현재 작업 디렉토리를 조회해서 탐색기에서 reveal + 펼침
- 터미널 안에서 `cd`로 이동해도 따라감 (`explorerSync.followCd` 설정으로 끌 수 있음)
- 열려있는 에디터 탭은 건드리지 않음

VS Code에는 이 방향의 내장 기능이 없다 ([microsoft/vscode#71641](https://github.com/Microsoft/vscode/issues/71641), as-designed로 닫힘).

### 2. 현재 프로젝트로 한정된 검색

큰 폴더를 연 창에서 검색이 전체에 걸리는 문제를 해결한다. "현재 프로젝트"는 마지막으로 포커스한 터미널의 cwd(또는 마지막으로 연 에디터 파일)에서 **위로 올라가며 `.git`이 있는 가장 가까운 조상 폴더**로 자동 판단한다 — 워크스페이스 루트에서 탐색을 멈추고, `.git`을 못 찾으면 그 폴더 자체로 폴백. 그래서 `~/claude-projects` 같은 컨테이너 루트를 싱글 루트로 열고 터미널에서 `k8s/apps/foo`로 `cd`해 들어가도, 검색·파일 열기가 그 레포 단위로 한정된다 (레포 안 하위 폴더로 더 들어가도 레포 루트로 잡힘).

진입점은 마우스 중심으로 두 곳:

- **검색 뷰 상단의 필터 버튼** (`$(filter)` 아이콘) — 클릭하면 검색 뷰의 "포함할 파일"이 현재 프로젝트(`./상대/경로`)로 채워진다. 한 번 채워지면 바꾸기 전까지 유지된다.
- **상태 표시줄의 현재 프로젝트 표시** (왼쪽 하단 `$(root-folder) 프로젝트명`) — 클릭하면 메뉴가 뜬다:
  - 현재 프로젝트에서 텍스트 검색
  - 현재 프로젝트에서 파일 열기 — 해당 프로젝트 파일만 QuickPick으로 표시 (Ctrl+P의 프로젝트 한정판, `files.exclude`/`search.exclude` 존중)
  - 다른 프로젝트로 전환 — 자동 판단을 수동으로 덮어쓰기. 워크스페이스 루트 하위의 git 레포를 깊이 3까지 자동 탐색해서 목록으로 보여준다 (루트 전체로 전환하는 항목 포함)

커맨드 팔레트(`Claude Code Companion: ...`)에서도 실행 가능하며, 기본 단축키는 제공하지 않는다 (원하면 키보드 단축키 설정에서 직접 할당).

### 3. Claude 응답 완료 / 입력 대기 알림

여러 터미널에서 Claude Code를 돌릴 때, 어느 프로젝트의 Claude가 **응답을 마쳤는지**(✅) 또는 **질문/권한 승인으로 입력을 기다리며 멈춰 있는지**(⏸️) VS Code 알림으로 알려준다. 알림의 "터미널로 이동" 버튼을 누르면 해당 프로젝트의 터미널로 포커스가 이동한다.

동작 방식: Claude Code의 [Stop 훅과 Notification 훅](https://code.claude.com/docs/en/hooks)이 이벤트 파일을 `~/.claude/companion-events/`에 쓰고, 확장이 이 디렉토리를 감시한다. 이벤트 종류는 페이로드의 `hook_event_name`으로 구분한다.

- 해당 프로젝트가 워크스페이스에 열려 있는 창에만 알림이 뜬다
- 프로젝트 식별은 워크스페이스 폴더가 아니라 **이벤트의 cwd** 기준 — 워크스페이스 루트가 컨테이너 폴더(`tools`, `k8s` 등)여도 그 안의 프로젝트를 정확히 구분한다
- "터미널로 이동"은 해당 cwd에서 도는 claude 프로세스의 부모 셸 pid와 `terminal.processId`를 매칭해서, 같은 폴더에 터미널이 여러 개여도 claude가 실제로 도는 터미널로 이동한다
- `permission_prompt`는 권한 승인뿐 아니라 Claude의 선택지 질문(AskUserQuestion)에도 발화한다 (Claude Code 2.1.212 실측, 공식 문서에는 명시 없음) — 승인 프롬프트가 드문 auto 권한 모드에서도 유용
- 알림이 뜰 때 사운드도 재생한다 (`notifications.sound.enabled`, 기본 켜짐) — WSL/Windows는 Windows 시스템 알림음, macOS는 `afplay`, Linux는 `paplay`
- `stopNotification.enabled` / `permissionNotification.enabled` 설정으로 각각 끌 수 있다
- `notifications.skipWhenViewing`을 켜면 해당 프로젝트 터미널을 보고 있을 때 알림을 생략한다 (터미널 패널이 닫혀 있어도 생략될 수 있는 오탐이 있어 기본 꺼짐)

**훅 필요**: `Stop`, `Notification` — [훅 설치](#훅-설치) 참고. 훅은 이벤트의 stdin JSON(cwd 포함)을 그대로 파일로 저장하며, 1시간 지난 이벤트 파일은 스스로 정리한다.

입력 대기 알림의 한계: 입력을 이미 처리했어도 확장이 떠 있는 토스트를 닫을 방법은 없다 (VS Code API에 알림 닫기/지속시간 제어 없음). 토스트는 창이 포커스돼 있으면 약 10초 뒤 자동으로 닫히고(알림 센터에는 남음), 포커스가 없는 동안은 계속 떠 있는다 — 이를 보완하는 상시 표시는 기능 6 참고.

### 4. Claude 세션 저장/복구

VS Code를 껐다 켜면 각 프로젝트 터미널에서 돌던 Claude 세션이 다 죽는 문제를 해결한다. 터미널 스크롤백은 살릴 수 없지만, 진짜 중요한 대화 세션은 `claude --resume <session_id>`로 복구된다.

동작 방식:

- **SessionStart 훅**이 세션 시작 시 `~/.claude/companion-sessions/<session_id>.json`에 기록 (cwd 포함). `claude -p` 단발 실행은 훅이 부모 프로세스의 cmdline에서 감지해 기록하지 않는다.
- **SessionEnd 훅**이 의도적 종료(`/exit`, `/clear`, logout — reason이 `prompt_input_exit`/`clear`/`logout`)일 때만 기록을 삭제한다. 창이 닫혀서 죽은 경우(SIGHUP)는 reason이 `other`라 기록이 남는다 — 실측 결과 SIGHUP에서도 SessionEnd 훅이 실행되므로 reason 구분이 필수다.
- **확장이 시작될 때** 남은 기록 중 이 창의 워크스페이스에 속한 것을 찾아 "복구할까요?" 알림을 띄운다. 수락하면 프로젝트(cwd)별 터미널을 만들어 `claude --resume <session_id>`를 실행한다.
- 창 리로드처럼 claude 프로세스가 살아있는 경우는 `/proc` 스캔(argv[0]이 `claude`인 프로세스의 cwd)으로 걸러내 이중 부활을 막는다. 생존 판정과 그룹핑 모두 cwd 기준이라 컨테이너 루트 워크스페이스에서도 프로젝트별로 각각 복구된다.
- **휴지통 버튼 등으로 터미널을 직접 닫은 경우**는 크래시와 달리 확장이 닫힘 이벤트(`onDidCloseTerminal`, reason이 `User`)를 받을 수 있다. 이때 잠시 뒤 이 창 소속이면서 살아있는 claude가 없는 기록을 지워, 의도적으로 닫은 세션은 다음 시작 때 복구 프롬프트에 뜨지 않는다. 어느 세션이 그 터미널 것이었는지는 알 수 없어 소거법이라, 응답하지 않고 넘긴 복구 프롬프트의 잔재도 이때 같이 정리될 수 있다.
- 커맨드 팔레트 `Claude Code Companion: Claude 세션 복구`로 수동 실행도 가능.
- 30일 지난 기록은 자동 정리.

**훅 필요**: `SessionStart`, `SessionEnd` — [훅 설치](#훅-설치) 참고.

### 5. Add to Claude Path

탐색기에서 파일/폴더를 우클릭하면 메뉴 최상단에 **Add to Claude Path**가 뜬다. 클릭하면 선택한 항목의 절대 경로가 활성 터미널(=Claude Code 입력창)에 개행 없이 타이핑되고 포커스가 터미널로 이동한다 — 이어서 프롬프트를 계속 쓰면 된다.

- 다중 선택 지원 (공백으로 구분해서 한꺼번에 입력)
- 공백이 포함된 경로는 자동으로 따옴표 처리
- 활성 터미널로 보내므로, 프로젝트 A의 채팅에 프로젝트 B의 파일 경로를 넣는 것도 가능

에디터용 변형 두 가지 (에디터 우클릭 메뉴):

- **Add Selection to Claude Path** — 선택한 코드의 위치를 `절대경로#L10-L25` 형태로 입력한다 (선택이 한 줄이면 `#L10`). 다중 커서 선택은 공백으로 구분해 전부 입력되고, 선택 없이 커맨드 팔레트에서 실행하면 커서 라인을 가리킨다. 라인 드래그로 선택 끝이 다음 줄 첫 칸에 걸친 경우 그 줄은 제외.
- **Add Diagnostics to Claude Path** — 현재 파일의 에러/경고를 `경로#L줄 [Error] 메시지 (소스)` 형태로 입력한다. 선택 영역이 있으면 그 범위와 겹치는 진단만. 터미널에서 개행은 프롬프트 제출이 되므로 여러 진단은 `; `로 이어 한 줄로 보내고, 심각한 것부터 최대 10개까지만 (초과분은 `(외 N개)`로 표기).

### 6. 프로젝트별 Claude 상태 추적

기능 3의 토스트는 놓치면 끝이다 — 입력 대기 중인 Claude를 못 보면 세션이 그대로 방치된다. 이를 보완해서 상태바에 프로젝트별 Claude 상태를 **상시 집계 표시**한다: `⏸️ 1  ✅ 1  ⏳ 2` (입력 대기 / 응답 완료 / 작업 중). 입력 대기가 하나라도 있으면 상태바 항목이 경고색으로 강조된다.

클릭하면 세션 목록이 뜨고(내 손이 필요한 순서로 정렬, 경과 시간 표시), 선택하면 해당 프로젝트의 터미널로 이동한다. 커맨드 팔레트 `Claude Code Companion: Claude 세션 상태`로도 열 수 있다.

상태 판정 (기능 3과 같은 이벤트 파일 방식, 훅 2개 추가 필요):

- `UserPromptSubmit` 훅 (프롬프트 제출) / `PostToolUse` 훅 (툴 실행 완료) → ⏳ 작업 중. PostToolUse가 있어야 권한 승인·질문 답변 후 작업 재개가 반영된다 (승인 자체에 대한 훅 이벤트는 없음 — 승인된 툴이 실행 완료되는 시점으로 갈음).
- `Notification(permission_prompt)` 훅 → ⏸️ 입력 대기
- `Stop` 훅 → ✅ 응답 완료 (다음 프롬프트를 제출하면 사라짐)
- claude 프로세스가 사라진 항목은 `/proc` 스캔으로 15초마다(+창 포커스 시) 자동 제거

한계:

- 상태는 창(메모리)에만 있어서 창 리로드 직후에는 다음 이벤트가 올 때까지 비어 있다
- 같은 폴더(cwd)에서 claude를 여러 개 돌리면 하나로 합쳐진다
- Esc로 응답을 중단한 경우 발화하는 훅이 없어 다음 이벤트까지 ⏳로 남는다
- PostToolUse 훅은 툴 호출마다 이벤트 파일을 하나 쓴다 (파일은 작고, 1시간 지난 파일은 훅이 스스로 정리) — 부담스러우면 이 훅만 빼도 된다. 승인 후 재개 반영만 늦어질 뿐 나머지는 동작한다.

**훅 필요**: `UserPromptSubmit`, `PostToolUse` (+ 기능 3의 `Stop`/`Notification`) — [훅 설치](#훅-설치) 참고.

### 7. 최근 세션 조회/복구 (모든 프로젝트)

기능 4가 "끊긴 세션"만 복구하는 것과 달리, **최근 실행한 모든 세션**을 워크스페이스 폴더와 무관하게 최신순으로 보여주고 아무 세션이나 다시 이어갈 수 있다. 어제 다른 폴더에서 하던 대화를 오늘 이 창에서 이어가는 용도.

- 진입점: 커맨드 팔레트 `Claude Code Companion: 최근 Claude 세션 조회/복구 (모든 프로젝트)` 또는 상태 표시줄 프로젝트 메뉴의 "최근 Claude 세션 복구"
- 목록에는 프로젝트명 · 마지막 사용 시각 · 폴더 경로 · 첫 프롬프트 미리보기가 표시되고, 프롬프트 내용으로도 검색된다
- 선택하면 해당 폴더에 터미널을 만들어 `claude --resume <session_id>` 실행 (`sessionRestore.claudeCommand` 설정 재사용)
- 데이터 소스는 Claude Code가 직접 남기는 대화 기록(`~/.claude/projects/<인코딩된 경로>/<session_id>.jsonl`) — **훅 불필요**. 최신순 30개까지 표시.
- 프롬프트가 하나도 없는 빈 세션과 폴더가 삭제된 프로젝트의 세션은 제외
- 해당 폴더에 이미 claude가 돌고 있으면 ⚠️로 표시된다 — 같은 세션을 중복으로 열지 않도록 주의

## 훅 설치

알림(기능 3)·세션 복구(기능 4)·상태 추적(기능 6)은 Claude Code 훅이 이벤트를 파일로 남겨줘야 동작한다. 커맨드 팔레트에서 **`Claude Code Companion: Claude Code 훅 설치/업데이트`** 를 실행하면 `~/.claude/settings.json`에 아래 훅 6개가 자동으로 추가/갱신된다.

| 훅 이벤트 | 용도 |
|---|---|
| `Stop` | 응답 완료 알림 + 상태 추적 |
| `Notification` (`permission_prompt`) | 입력 대기 알림 + 상태 추적 |
| `UserPromptSubmit` | 상태 추적 — 작업 시작 |
| `PostToolUse` | 상태 추적 — 승인/질문 답변 후 재개 |
| `SessionStart` | 세션 복구용 활성 세션 기록 |
| `SessionEnd` | 의도적 종료 시 세션 기록 삭제 |

동작 방식:

- 변경 전 기존 파일을 `settings.json.bak`으로 백업하고, companion 훅이 아닌 사용자 훅은 순서 포함 그대로 보존한다
- "이 확장의 훅"은 커맨드 문자열의 `/.claude/companion-` 경로 참조로 식별한다 — 수동 설치했던 훅도 관리 대상이 되고, 확장 업데이트로 훅 명세가 바뀌면 구버전 커맨드를 자동 교체한다 (직접 커스텀한 companion 훅도 표준 명세로 교체되니 주의)
- 확장 시작 시 훅이 없거나 구버전이면 설치를 제안한다 (`hooks.checkOnStartup` 설정으로 끌 수 있고, "이 버전은 묻지 않음"은 훅 명세 버전 단위로 기억된다)
- 훅 커맨드 원문은 [`hooks.js`](hooks.js)에 있다 — 원하면 수동 설치도 가능
- 훅 변경은 **새로 시작하는 claude 세션부터** 적용된다

## 설치

[Releases](https://github.com/LemonDouble/vscode-claude-code-companion/releases)에서 vsix를 받거나, 직접 빌드한다:

```bash
npx --yes @vscode/vsce package
code --install-extension vscode-claude-code-companion-0.14.0.vsix
```

WSL 환경이라면 VS Code 통합 터미널(WSL)에서 실행해야 WSL 쪽에 설치된다.
UI로 설치하려면: 확장 탭 → `...` 메뉴 → "Install from VSIX...".

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `claudeCodeCompanion.explorerSync.enabled` | `true` | 터미널 포커스 시 탐색기 이동 |
| `claudeCodeCompanion.explorerSync.followCd` | `true` | 터미널 안에서 cd 할 때도 따라 이동 |
| `claudeCodeCompanion.stopNotification.enabled` | `true` | Claude 응답 완료 시 알림 표시 |
| `claudeCodeCompanion.permissionNotification.enabled` | `true` | Claude 입력 대기(질문/승인) 시 알림 표시 |
| `claudeCodeCompanion.notifications.skipWhenViewing` | `false` | 보고 있는 프로젝트의 알림 생략 (옵트인) |
| `claudeCodeCompanion.notifications.sound.enabled` | `true` | 알림 표시 시 사운드 재생 |
| `claudeCodeCompanion.statusTracker.enabled` | `true` | 상태바에 프로젝트별 Claude 상태 집계 표시 |
| `claudeCodeCompanion.hooks.checkOnStartup` | `true` | 시작 시 훅 설치/최신 여부 확인 후 설치 제안 |
| `claudeCodeCompanion.sessionRestore.enabled` | `true` | 시작 시 끊긴 Claude 세션 복구 여부 물어보기 |
| `claudeCodeCompanion.sessionRestore.claudeCommand` | `claude` | 복구 시 사용할 claude 실행 명령 |

커맨드 팔레트에서 `Claude Code Companion: 터미널-탐색기 동기화 켜기/끄기`로 토글 가능.

## 요구사항

- VS Code 1.93 이상 (셸 통합 API)
- 터미널 셸 통합 활성화 (bash/zsh 등에서 기본 자동 주입, `terminal.integrated.shellIntegration.enabled`)
- 탐색기 동기화는 터미널의 cwd가 열린 워크스페이스 폴더 안에 있을 때만 동작

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
