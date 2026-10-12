# ko-tone-guard

Claude Code와 Codex의 커밋 메시지·코드 주석·PR 설명에서 AI 티 나는 한국어 표현을 검사하는 플러그인.

`git commit`이나 `gh pr create`를 실행하기 전에 문체를 검사한다. 문제가 있으면 명령을 막고, 고칠 표현과 이유를 에이전트에게 돌려준다.

## 검사 대상

- 커밋 메시지
- 이번 커밋에 추가되는 코드 주석: staged 변경, 같은 명령의 `git add`, `commit -a`
- PR 제목과 본문: `--title`, `--body`, heredoc, `--body-file`

| 종류 | 예 |
|---|---|
| 과장·홍보 문구 | 획기적, 완벽하게, 게임 체인저, 극대화 |
| 근거 없는 자평 | 견고한, 우아하게 |
| 거창한 틀 | 진정한 ~, 단순히 A가 아니라 B |
| 비유적 영어 유행어 | load-bearing, seamless |
| 직역체 | ~에 의해, ~를 가지고 있다, 운영에 있어서 |
| 겹친 단서 | ~일 수도 있을 가능성 |
| 긴 주석 | 3줄 이상 또는 16어절 이상인 주석 블록 |

## 설치

### Claude Code

```sh
claude plugin marketplace add j-zzi/ko-tone-guard
claude plugin install ko-tone-guard@ko-tone-guard
```

설치 후 새 세션을 시작한다.

### Codex

Bun이 설치되어 있고, Codex가 실행하는 명령에서 `bun`을 찾을 수 있어야 한다.

```sh
codex plugin marketplace add j-zzi/ko-tone-guard --ref main
codex plugin add ko-tone-guard@ko-tone-guard
```

새 세션에서 `/hooks`를 열어 `ko-tone-guard` 훅을 검토하고 신뢰한다. Codex는 신뢰하지 않은 훅을 실행하지 않는다. 사용하는 버전에서 훅 기능 활성화가 필요하면 `~/.codex/config.toml`의 기존 `[features]`에 `hooks = true`를 추가한다. [공식 Hooks 문서](https://learn.chatgpt.com/docs/hooks)

이 저장소는 GitHub 마켓플레이스로 배포한다. 훅이 포함된 플러그인은 OpenAI 공개 플러그인 디렉터리 제출 대상이 아니다. [공식 플러그인 문서](https://developers.openai.com/plugins/build/plugins)

## 검사 방식과 설정

검사기를 실행 환경과 독립적으로 선택한다. Claude Code에서 Codex CLI를, Codex에서 Claude CLI를 사용할 수 있다. 선택한 모델 접두사로 검사기를 결정하며 대화 중인 모델을 자동으로 따라가지는 않는다.

| 모델 설정 | 검사기 |
|---|---|
| `claude:sonnet` 또는 `claude:모델명` | Claude CLI (`claude -p`) |
| `codex:모델명` | Codex CLI (`codex exec`) |
| `ollama:gemma4:12b-it-qat` 또는 `ollama:모델명` | Ollama HTTP API |
| `off` | 모델 검사 끄기 |

Claude·Codex CLI는 설치 및 로그인이 필요하고, 훅 프로세스에서 해당 실행 파일을 찾을 수 있어야 한다. 지정한 모델은 검사 CLI에 그대로 전달한다. CLI는 일회성으로 실행하고 검사 대상 텍스트를 stdin으로 보낸다. Claude 검사에는 도구·MCP를 끄고, Codex 검사에는 셸·웹 검색을 끄고 읽기 전용 샌드박스를 사용한다. 검사 자식 프로세스에는 훅 재진입 방지 표시를 전달한다. CLI 응답이 없거나 형식이 잘못되면 알림과 함께 정규식·긴 주석 검사를 계속한다. 모델 검사 전체에 90초, 각 호출에 최대 65초를 할당한다.

기존 Ollama 설정은 계속 지원한다. 새 모델 설정이 비어 있으면 기존 설정을 사용한다.

| 검사 | Claude Code 기본값 | Codex 기본값 | 지적 시 동작 |
|---|---|---|---|
| 정규식 문체 검사 | 켜짐 | 켜짐 | 고칠 때까지 매번 차단 |
| 긴 주석 검사 | 켜짐 | 켜짐 | 한 번 차단, 같은 명령을 다시 실행하면 통과 |
| 기본 모델 검사 | `gemma4:12b-it-qat` 사용 시도 | 꺼짐 | 한 번 차단, 같은 명령을 다시 실행하면 통과 |

모델 검사는 정규식이 놓치는 표현을 검사하는 선택 기능이다. 에이전트가 사용하는 Claude·Codex 모델은 바꾸지 않아도 된다. Ollama가 없거나 응답하지 않으면 정규식과 긴 주석 검사를 계속하고 알림을 남긴다. 검사기 자체에 오류가 나면 알림을 남기고 명령을 통과시킨다.

### Claude Code의 검사 모델 설정

```sh
claude plugin configure ko-tone-guard@ko-tone-guard
```

| 설정 | 기본값 | 설명 |
|---|---|---|
| `checkerModel` | 빈 문자열 | `claude:모델`, `codex:모델`, `ollama:모델`, `off`. 빈 문자열이면 기존 Ollama 설정 사용 |
| `ollamaUrl` | `http://localhost:11434` | Ollama 서버 주소 |
| `ollamaModel` | `gemma4:12b-it-qat` | 기존 Ollama 모델 설정. `checkerModel`이 비어 있을 때만 사용 |

예를 들어 Claude Code에서 Codex CLI로 검사하려면 (모델명은 사용할 모델로 바꾼다):

```sh
printf '%s\n' '{"checkerModel":"codex:모델명"}' | claude plugin configure ko-tone-guard@ko-tone-guard --values-stdin
```

LLM 검사를 끄려면:

```sh
printf '%s\n' '{"checkerModel":"off"}' | claude plugin configure ko-tone-guard@ko-tone-guard --values-stdin
```

### Codex의 검사 모델 설정

Codex를 실행하는 환경에 아래 변수를 설정한다.

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `KO_TONE_GUARD_MODEL` | 빈 문자열 | `claude:모델`, `codex:모델`, `ollama:모델`, `off`. 빈 문자열이면 기존 Ollama 설정 사용 |
| `KO_TONE_GUARD_OLLAMA_URL` | `http://localhost:11434` | Ollama 서버 주소 |
| `KO_TONE_GUARD_OLLAMA_MODEL` | 빈 문자열 | 기존 Ollama 모델 설정. `KO_TONE_GUARD_MODEL`이 비어 있을 때만 사용 |

예를 들어 Codex에서 Claude CLI로 검사하려면:

```sh
export KO_TONE_GUARD_MODEL=claude:sonnet
codex
```

Ollama를 사용하려면:

```sh
ollama pull gemma4:12b-it-qat
export KO_TONE_GUARD_MODEL=ollama:gemma4:12b-it-qat
codex
```

## 업데이트

Claude Code:

```sh
claude plugin marketplace update ko-tone-guard
claude plugin update ko-tone-guard@ko-tone-guard
```

Codex:

```sh
codex plugin marketplace upgrade ko-tone-guard
codex plugin add ko-tone-guard@ko-tone-guard
```

업데이트 후 새 세션을 시작한다. Codex에서 훅 정의가 바뀌면 `/hooks`에서 다시 검토하고 신뢰한다.

## 오탐 우회

오탐이 확실하면 명령 앞에 `KO_TONE_GUARD=off`를 붙여 검사 전체를 건너뛸 수 있다. 에이전트에게는 사용자 확인을 받은 뒤에만 우회하라고 안내한다.

```sh
KO_TONE_GUARD=off git commit -m "..."
```

## 한계

- 실행할 명령 문자열을 파싱한다. 셸 변수로 넘긴 경로(`git -C $DIR`, `--body-file $F`)는 같은 명령 안에서 대입한 경우만 풀 수 있다. 풀지 못하면 리터럴 경로로 다시 실행하라고 차단한다.
- 주석 검사는 `.ts`·`.js`·`.sh`·`.sql`·`.py`·`.yaml` 계열 파일을 대상으로 한다.
- 모델 지적과 긴 주석 경고는 재시도 시 통과하므로 강제 규칙으로 쓰기에는 한계가 있다.

## 개발

| 역할 | Claude Code | Codex |
|---|---|---|
| 플러그인 manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| 훅 설정 | `hooks/claude.json` | `hooks/codex.json` |
| 연결 코드 | `hooks/claude.ts` | `hooks/codex.ts` |
| 공통 검사 | `hooks/guard.ts`, `hooks/checker.ts`, `hooks/tone.ts`, `hooks/parse.ts` | 동일 |

```sh
claude plugin validate .
claude plugin test .
python3 tests/codex.test.py
```

Claude 테스트는 모의 호스트에서 검사 동작을 확인한다. Codex 테스트는 임시 Git 저장소에서 훅 프로세스를 실행해 차단·통과·재시도 동작을 확인한다.

Claude Code에서 로컬 플러그인을 로드하려면:

```sh
claude --plugin-dir .
```

Codex에서 로컬 변경을 설치해 확인하려면:

```sh
codex plugin marketplace add /absolute/path/ko-tone-guard
codex plugin add ko-tone-guard@ko-tone-guard
```

설치된 캐시를 읽으므로 변경 후 다시 설치하고 새 세션을 시작한다.

Claude 타입 정의(`.claude-plugin/types/`)는 Claude Code가 플러그인을 로드할 때 생성한다. `tsc -p .`는 Claude 연결부와 공통 검사 코드를 검사한다. Codex 연결부는 별도 런타임을 사용하므로 이 타입 검사에서 제외하고 위 프로세스 테스트로 검증한다.

## License

MIT
