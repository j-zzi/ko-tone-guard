# ko-tone-guard

Claude Code와 Codex가 쓰는 한국어 기술 문장에서 AI 티 나는 표현을 커밋·PR 전에 잡는 플러그인.

Bash로 `git commit`이나 `gh pr create`를 실행하기 직전에 아래를 검사하고, 걸리면 실행을 막고 고칠 표현을 에이전트에게 돌려준다.

- 커밋 메시지
- 이번 커밋에 추가되는 코드 주석 (staged 변경 + 같은 명령의 `git add`, `commit -a`)
- PR 제목·본문 (`--body`, heredoc, `--body-file`)

## 무엇을 잡나

| 종류 | 예 |
|---|---|
| 과장·홍보 문구 | 획기적, 완벽하게, 게임 체인저, 극대화 |
| 근거 없는 자평 | 견고한, 우아하게 |
| 거창한 틀 | 진정한 ~, 단순히 A 가 아니라 B |
| 비유적 영어 유행어 | load-bearing, seamless |
| 직역체 | ~에 의해, ~를 가지고 있다, 운영에 있어서 |
| 겹친 단서 | ~일 수도 있을 가능성 |
| 긴 주석 | 3줄 이상 또는 16어절 이상인 주석 블록 |

판정은 두 단계다.

- **정규식** — 확실한 표현. 걸리면 고칠 때까지 매번 막는다.
- **로컬 LLM (Ollama)** — 정규식이 못 잡는 표현. 오탐이 있어 한 번만 막고, 같은 명령을 그대로 다시 실행하면 통과한다. 긴 주석 경고도 같다.

Ollama 가 없거나 응답하지 않으면 정규식으로만 검사하고 토스트로 알린다. 검사 자체가 오류를 내도 명령은 막지 않는다.

## 설치

Claude Code 터미널에서:

```
/plugin install ko-tone-guard --marketplace j-zzi/ko-tone-guard
```

마켓플레이스 추가를 묻으면 `y`, scope 는 user 를 고른다. 설치한 세션부터 바로 적용된다.

### Codex

Bun이 PATH에 있어야 한다. Codex용 manifest는 `.codex-plugin/plugin.json`, 훅 설정은 `hooks/codex.json`이다. Claude용 훅과 검사 로직을 공유한다.

```sh
codex plugin marketplace add j-zzi/ko-tone-guard --ref main
codex plugin add ko-tone-guard@ko-tone-guard
```

설치 후 새 세션의 `/hooks`에서 훅을 검토하고 신뢰한다.

로컬에서 사용하려면 저장소를 내려받고 대상 프로젝트의 `.codex/config.toml`에 아래 설정을 추가한다. 명령의 경로는 내려받은 저장소의 절대 경로로 바꾼다.

```toml
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'bun run "/absolute/path/ko-tone-guard/hooks/codex.ts"'
timeout = 120
statusMessage = "한국어 문체 검사"
```

기존 설정이 있으면 해당 항목에 합친다. Codex 세션을 다시 시작하고 `/hooks`에서 훅을 검토하고 신뢰한다. Codex는 실행 전 훅 신뢰 검토를 요구한다. [공식 Hooks 문서](https://learn.chatgpt.com/docs/hooks)

Codex에서는 기본으로 정규식과 긴 주석만 검사한다. 다른 모델을 설치하거나 Codex 모델을 바꿀 필요가 없다. Ollama 검사도 쓰려면 Codex 실행 환경에 `KO_TONE_GUARD_OLLAMA_MODEL`을 설정한다. 서버 주소는 `KO_TONE_GUARD_OLLAMA_URL`로 바꿀 수 있다(기본 `http://localhost:11434`).

플러그인으로 묶은 훅은 Codex desktop 수동 설치용이다. 공개 플러그인 디렉터리는 훅이 포함된 플러그인을 받지 않는다. [공식 플러그인 문서](https://developers.openai.com/plugins/build/plugins)

### LLM 검사 (선택, Claude Code)

```sh
ollama pull gemma4:12b-it-qat
```

다른 모델이나 원격 서버를 쓰려면 `/config` 에서 바꾼다.

| 설정 | 기본값 | 설명 |
|---|---|---|
| `ollamaUrl` | `http://localhost:11434` | Ollama 서버 주소 |
| `ollamaModel` | `gemma4:12b-it-qat` | 비우면 LLM 검사를 끄고 정규식만 쓴다 |

## 우회

오탐이 확실하면 명령 앞에 `KO_TONE_GUARD=off`를 붙이면 검사하지 않는다. 에이전트에게는 사용자 확인을 받은 뒤에만 붙이라고 안내한다.

```sh
KO_TONE_GUARD=off git commit -m "..."
```

## 한계

- 명령 문자열만 보고 판단한다. 셸 변수로 넘긴 경로(`git -C $DIR`, `--body-file $F`)는 같은 명령 안에서 대입한 경우만 풀고, 나머지는 리터럴 경로로 다시 실행하라고 막는다.
- 주석은 `.ts`·`.js`·`.sh`·`.sql`·`.py`·`.yaml` 계열 파일만 본다.

## 개발

```sh
claude plugin validate .
claude plugin test .
python3 tests/codex.test.py
claude --plugin-dir .      # 이 폴더를 로드한 세션
```

타입 정의(`.claude-plugin/types/`)는 Claude Code 가 플러그인을 처음 로드할 때 만든다. 그 뒤에 `tsc -p .` 로 타입을 검사할 수 있다.

| 역할 | Claude Code | Codex |
|---|---|---|
| 훅 설정 | `hooks/claude.json` | `hooks/codex.json` |
| 연결 코드 | `hooks/claude.ts` | `hooks/codex.ts` |
| 공통 검사 | `hooks/guard.ts` | 동일 |

## License

MIT
