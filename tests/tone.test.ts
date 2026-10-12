import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GIT_COMMIT, codeOnly, commitMessage, expandHome, hasUnresolvedVar, pendingChanges, prBody, prBodyFile, prTitle, targetDir } from '../hooks/parse'
import { addedComments, chunks, longComments, parseOllama, regexIssues } from '../hooks/tone'

// ollama 가 없으면 curl 이 실패한 것처럼 답해 LLM 을 건너뛰게 한다.
type Fake = {
  ollama?: { phrase: string; reason: string }[]
  diff?: string
  unstaged?: string
  untracked?: Record<string, string>
}

function ollamaReply(issues: { phrase: string; reason: string }[]) {
  return JSON.stringify({ message: { content: JSON.stringify({ issues }) } })
}

// 테스트 환경엔 프로세스가 없어 process.run 을 아래에서 대신 답한다.
function fakeHost(on: On, fake: Fake, ran: string[], calls: string[] = [], stdins: string[] = []) {
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ')
    calls.push(argv)
    stdins.push(e.init?.stdin ?? '')
    if (argv === 'printenv HOME') return out(0, '/home/u')
    if (argv.includes('diff --cached')) return out(0, fake.diff ?? '')
    if (argv.includes('ls-files --others')) return out(0, Object.keys(fake.untracked ?? {}).join('\n'))
    if (argv.includes('--no-index')) return out(1, fake.untracked?.[e.argv.at(-1) ?? ''] ?? '')
    if (argv.includes('diff -U0')) return out(0, fake.unstaged ?? '')
    if (argv.startsWith('curl')) return fake.ollama ? out(0, ollamaReply(fake.ollama)) : out(7, '')
    return out(1, '')
  })
  on('tool.call', async (_$, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
}

function out(exitCode: number, stdout: string) {
  return { value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
}

describe('문체 검사', () => {
  test('커밋·PR 이 아닌 명령은 그대로', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    await $.tool.call({ tool: 'Bash', command: 'echo 획기적' })
    expect(ran).toEqual(['echo 획기적'])
  })

  test('정규식 표현은 ollama 가 꺼져 있어도 막는다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 획기적인 캐시"' })
    expect(r.deny).toContain('획기적')
    expect(ran).toEqual([])
  })

  test('LLM 지적은 원문에 있는 구절만 쓴다', async ($, on) => {
    const ran: string[] = []
    const fake: Fake = { ollama: [{ phrase: '탄탄한 기반', reason: '과장' }] }
    fakeHost(on, fake, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 탄탄한 기반을 마련한다"' })
    expect(r.deny).toContain('탄탄한 기반')
    // LLM 지적은 경고라 같은 명령을 다시 내면 통과한다.
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 탄탄한 기반을 마련한다"' })
    expect(ran).toEqual(['git commit -m "feat: 탄탄한 기반을 마련한다"'])
    ran.length = 0

    fake.ollama = [{ phrase: '게임 체인저', reason: '과장' }]
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 캐시를 붙인다"' })
    expect(ran).toEqual(['git commit -m "feat: 캐시를 붙인다"'])
  })

  test('직역체·겹친 단서는 정규식으로 막는다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    const r = await $.tool.call({
      tool: 'Bash',
      command: 'git commit -m "fix: 주문은 워커에 의해 처리된다" -m "재시도가 실패할 수도 있을 가능성이 있다."',
    })
    expect(r.deny).toContain('"에 의해" — 직역체')
    expect(r.deny).toContain('"수도 있을 가능성" — 겹친 단서')
    expect(ran).toEqual([])
  })

  test('"에 있어서"는 직역체 용법만 정규식으로 잡는다', () => {
    expect(regexIssues('운영에 있어서 알림은 중요하다')).toEqual([{ phrase: '운영에 있어서', reason: '직역체' }])
    expect(regexIssues('세션이 캐시에 있어서 빠르다')).toEqual([])
  })

  test('정규식과 원문 위치가 겹치는 LLM 지적은 한 번만 보인다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, { ollama: [{ phrase: '가지고 있다', reason: '직역체' }] }, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 모듈은 핸들러를 가지고 있다"' })
    expect(r.deny).toContain('"를 가지고 있" — 직역체')
    expect(r.deny).not.toContain('"가지고 있다"')
  })

  test('Ollama 가 실패하면 정규식만으로 판정하고 토스트로 알린다', async ($, on) => {
    const ran: string[] = []
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    fakeHost(on, {}, ran)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 캐시를 붙인다"' })
    expect(ran).toEqual(['git commit -m "fix: 캐시를 붙인다"'])
    expect(toasts).toEqual(['ko-tone-guard: Ollama 응답 실패 — 문체는 정규식으로만 검사했다'])
  })

  test('Ollama 가 답하면 토스트를 띄우지 않는다', async ($, on) => {
    const ran: string[] = []
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    fakeHost(on, { ollama: [] }, ran)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 캐시를 붙인다"' })
    expect(toasts).toEqual([])
  })

  test('정규식 지적은 다시 내도 막는다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    const cmd = 'git commit -m "feat: 획기적인 캐시"'
    expect((await $.tool.call({ tool: 'Bash', command: cmd })).deny).toContain('과장')
    expect((await $.tool.call({ tool: 'Bash', command: cmd })).deny).toContain('과장')
    expect(ran).toEqual([])
  })

  test('새로 추가된 주석도 본다', async ($, on) => {
    const ran: string[] = []
    const diff = '+++ b/src/a.ts\n@@ -1 +1 @@\n+// 이 락 순서는 load-bearing 결정이다\n+const a = 1'
    fakeHost(on, { diff }, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 락 순서"' })
    expect(r.deny).toContain('추가된 주석')
  })

  test('같은 명령에서 add 하는 파일의 주석도 본다', async ($, on) => {
    const ran: string[] = []
    const fake: Fake = {
      unstaged: '+++ b/src/a.ts\n@@ -1 +1 @@\n+// 견고한 락 순서를 쓴다\n',
      untracked: { 'src/new.ts': '+++ b/src/new.ts\n@@ -0,0 +1 @@\n+// 우아하게 푼다\n' },
    }
    fakeHost(on, fake, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git add src/a.ts src/new.ts && git commit -m "fix: 락"' })
    expect(r.deny).toContain('[추가된 주석] "견고한"')
    expect(r.deny).toContain('[추가된 주석] "우아하게"')
  })

  test('commit -am 의 메시지도 검사한다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -am "feat: 획기적인 캐시"' })
    expect(r.deny).toContain('[커밋 메시지] "획기적"')
  })

  test('경로에 못 푼 변수가 있으면 커밋·PR 을 막는다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    expect((await $.tool.call({ tool: 'Bash', command: 'git -C $WT commit -m "fix: 락"' })).deny).toContain('리터럴 경로')
    expect((await $.tool.call({ tool: 'Bash', command: 'gh pr create -t "fix: 락" --body-file $F' })).deny).toContain('리터럴 경로')
    expect((await $.tool.call({ tool: 'Bash', command: 'git -C ~bob/repo commit -m "fix: 락"' })).deny).toContain('리터럴 경로')
    expect(ran).toEqual([])
  })

  test('~/ 경로는 홈으로 풀어 그 저장소의 diff 를 본다', async ($, on) => {
    const ran: string[] = []
    const calls: string[] = []
    fakeHost(on, {}, ran, calls)
    await $.tool.call({ tool: 'Bash', command: 'git -C ~/repo commit -m "fix: 락"' })
    expect(calls).toContain('git -C /home/u/repo diff --cached -U0 --no-color')
  })

  test('commit -a 는 추적 중인 파일 변경만 본다', async ($, on) => {
    const ran: string[] = []
    const fake: Fake = {
      unstaged: '+++ b/src/a.ts\n@@ -1 +1 @@\n+// 견고한 락 순서를 쓴다\n',
      untracked: { 'src/new.ts': '+++ b/src/new.ts\n@@ -0,0 +1 @@\n+// 우아하게 푼다\n' },
    }
    fakeHost(on, fake, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -am "fix: 락"' })
    expect(r.deny).toContain('"견고한"')
    expect(r.deny).not.toContain('"우아하게"')
  })

  test('긴 주석은 한 번 막고 다시 내면 통과', async ($, on) => {
    const ran: string[] = []
    const diff = '+++ b/src/a.ts\n@@ -1 +1,4 @@\n+// 첫째 줄\n+// 둘째 줄\n+// 셋째 줄\n+const a = 1'
    fakeHost(on, { diff }, ran)
    const cmd = 'git commit -m "fix: 주석"'
    expect((await $.tool.call({ tool: 'Bash', command: cmd })).deny).toContain('src/a.ts: "첫째 줄" — 3줄')
    await $.tool.call({ tool: 'Bash', command: cmd })
    expect(ran).toEqual([cmd])
  })

  test('PR 본문을 검사하고, 우회 표시가 있으면 통과', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, { ollama: [{ phrase: '핵심은', reason: '거창한 틀' }] }, ran)
    const body = `gh pr create --title "feat: 쿠폰" --body "$(cat <<'EOF'\n이번 변경의 핵심은 락이다\nEOF\n)"`
    const r = await $.tool.call({ tool: 'Bash', command: body })
    expect(r.deny).toContain('PR 본문')
    await $.tool.call({ tool: 'Bash', command: `KO_TONE_GUARD=off ${body}` })
    expect(ran).toEqual([`KO_TONE_GUARD=off ${body}`])
  })
})

describe('설정', () => {
  test('ollamaUrl·ollamaModel 로 호출한다', { options: { ollamaUrl: 'http://gpu:8080/', ollamaModel: 'qwen3' } }, async ($, on) => {
    const ran: string[] = []
    const calls: string[] = []
    const stdins: string[] = []
    fakeHost(on, { ollama: [] }, ran, calls, stdins)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 캐시"' })
    const curl = calls.findIndex(c => c.startsWith('curl'))
    expect(calls[curl]).toContain('http://gpu:8080/api/chat')
    expect(JSON.parse(stdins[curl]!).model).toBe('qwen3')
  })

  test('ollamaModel 이 비면 LLM 없이 정규식만 쓴다', { options: { ollamaModel: '' } }, async ($, on) => {
    const ran: string[] = []
    const calls: string[] = []
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    fakeHost(on, { ollama: [{ phrase: '캐시', reason: 'x' }] }, ran, calls)
    expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 획기적인 캐시"' })).deny).toContain('획기적')
    expect(calls.some(c => c.startsWith('curl'))).toBe(false)
    expect(toasts).toEqual([])
  })
})

describe('파싱', () => {
  test('PR 제목·본문·본문 파일을 뽑는다', () => {
    expect(prTitle('gh pr create -t "feat: a" -b "본문"')).toBe('feat: a')
    expect(prBody('gh pr create -t "feat: a" -b "본문"')).toBe('본문')
    expect(prBody(`gh pr create --body "$(cat <<'EOF'\n## 요약\n내용\nEOF\n)"`)).toBe('## 요약\n내용')
    expect(prBodyFile('gh pr create --body-file /tmp/b.md')).toBe('/tmp/b.md')
    expect(prBody('gh pr create --base main --title x')).toBeUndefined()
  })

  test('긴 주석: 줄 수·어절 수 한도, 지시어·빈 JSDoc 줄 제외', () => {
    const many = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ')
    const diff = [
      '+++ b/src/a.ts',
      '+// 짧은 한 줄',
      '+const x = 1',
      `+// ${many}`,
      '+const y = 2',
      '+/**',
      '+ * 첫째',
      '+ *',
      '+ * 둘째',
      '+ */',
      '+// eslint-disable-next-line',
      '+// 두 줄 중 하나',
      '+// 두 줄 중 둘',
      '+++ b/README.md',
      '+# 제목 하나 둘 셋 넷',
    ].join('\n')
    expect(longComments(diff)).toEqual([`src/a.ts: "${many.slice(0, 40)}…" — 1줄·16어절`])
  })

  test('주석 추출·분할·환각 필터', () => {
    const diff = '+++ b/a.ts\n+// 짧음\n+// eslint-disable-next-line\n+/* 왜 이렇게 했는지 남긴다 */\n+++ b/README.md\n+# 제목은 주석이 아니다'
    expect(addedComments(diff)).toBe('왜 이렇게 했는지 남긴다')
    expect(chunks('a'.repeat(800) + '\n\n' + 'b'.repeat(800))).toHaveLength(2)
    expect(parseOllama(ollamaReply([{ phrase: '핵심은 ~', reason: 'r' }, { phrase: '없는 말', reason: 'r' }]), '핵심은 락')).toEqual([
      { phrase: '핵심은', reason: 'r' },
    ])
  })


  test('경로와 메시지를 뽑는다', () => {
    expect(targetDir('git -C /a/b commit -m x')).toBe('/a/b')
    expect(targetDir('cd "/a b" && git commit')).toBe('/a b')
    expect(targetDir('git commit -m x')).toBeUndefined()
    expect(commitMessage(`git commit -m "$(cat <<'EOF'\nfeat: 제목\n\n본문\nEOF\n)"`)).toBe('feat: 제목\n\n본문')
    expect(commitMessage('git commit -m "feat: a \\"b\\"" -m "body"')).toBe('feat: a "b"\n\nbody')
    expect(commitMessage('git commit --amend --no-edit')).toBeUndefined()
  })

  test('git 전역 옵션이 끼어도 커밋으로 본다', () => {
    expect(GIT_COMMIT.test('git -C /a -c core.hooksPath=/dev/null commit -m x')).toBe(true)
    expect(GIT_COMMIT.test('git --no-pager commit -m x')).toBe(true)
    expect(GIT_COMMIT.test('git log --grep commit')).toBe(false)
    expect(targetDir('git -c a=b -C /a commit -m x')).toBe('/a')
    // commit 뒤의 -C 는 "메시지 재사용" 옵션이라 경로가 아니다.
    expect(targetDir('git commit -C HEAD')).toBeUndefined()
  })

  test('heredoc·따옴표 안의 git 명령은 명령으로 보지 않는다', async ($, on) => {
    const ran: string[] = []
    fakeHost(on, {}, ran)
    const heredoc = "python3 - <<'EOF'\ns = 'git -C $WT commit -m x'\nEOF"
    const quoted = 'grep -n "git commit -m" a.ts'
    for (const cmd of [heredoc, quoted]) await $.tool.call({ tool: 'Bash', command: cmd })
    expect(ran).toEqual([heredoc, quoted])
    expect((await $.tool.call({ tool: 'Bash', command: `bash -c "git commit -m '획기적인 캐시'"` })).deny).toBeDefined()
    const example = "cat <<'EOF' > n.md\n예: bash -c \"git commit -m '획기적인 캐시'\"\nEOF"
    await $.tool.call({ tool: 'Bash', command: example })
    expect(ran).toEqual([heredoc, quoted, example])
    expect((await $.tool.call({ tool: 'Bash', command: "bash <<'EOF'\ngit commit -m '획기적인 캐시'\nEOF" })).deny).toBeDefined()
    expect(codeOnly('git commit -m "a b"')).toHaveLength('git commit -m "a b"'.length)
    expect(targetDir('git -C "/a b" commit -m "fix: x"')).toBe('/a b')
    expect(commitMessage('echo "git commit" && git commit -m "fix: x"')).toBe('fix: x')
  })

  test('따옴표 짝이 안 맞으면 비우지 않고, 이스케이프·주석은 셸처럼 읽는다', () => {
    expect(GIT_COMMIT.test(codeOnly("echo it's ok && git commit -m x"))).toBe(true)
    expect(commitMessage("echo it\\'s ok && git commit -m 'fix: x'")).toBe('fix: x')
    expect(GIT_COMMIT.test(codeOnly("ls # it's git commit 예시\necho done"))).toBe(false)
    expect(GIT_COMMIT.test(codeOnly('echo "a \\" git commit"'))).toBe(false)
    const cmd = "echo it\\'s && git commit -m '한글 메시지'"
    expect(codeOnly(cmd)).toHaveLength(cmd.length)
  })

  test('같은 명령 안의 변수 대입은 풀고, 못 푼 변수는 남긴다', () => {
    expect(targetDir('R=/a/b; git -C $R commit -m x')).toBe('/a/b')
    expect(targetDir('R="/a b" && git -C "${R}/c" commit -m x')).toBe('/a b/c')
    expect(targetDir('R=/a; cd $R && git commit -m x')).toBe('/a')
    expect(hasUnresolvedVar(targetDir('git -C $WT commit -m x'))).toBe(true)
    expect(prBodyFile('F=/tmp/b.md; gh pr create -t x --body-file "$F"')).toBe('/tmp/b.md')
    expect(expandHome('~/a', '/home/u')).toBe('/home/u/a')
    expect(expandHome('~', '/home/u')).toBe('/home/u')
    expect(expandHome('~bob/a', '/home/u')).toBe('~bob/a')
  })

  test('같은 명령에서 커밋될 변경을 뽑는다', () => {
    expect(pendingChanges('git commit -m "fix: a b"')).toBeUndefined()
    expect(pendingChanges('git add "a b.ts" c.ts && git commit -m "fix: x"')).toEqual({ all: false, paths: ['a b.ts', 'c.ts'], untracked: true })
    expect(pendingChanges('git add . && git commit -m "fix: x"')).toEqual({ all: true, paths: [], untracked: true })
    expect(pendingChanges('git add -u && git commit -m "fix: x"')).toEqual({ all: true, paths: [], untracked: false })
    expect(pendingChanges('git commit -am "fix: x y"')).toEqual({ all: true, paths: [], untracked: false })
    expect(pendingChanges('git commit -m "fix: x" -- a.ts')).toEqual({ all: false, paths: ['a.ts'], untracked: false })
    expect(pendingChanges('git commit a.ts -m "fix: x" && git push')).toEqual({ all: false, paths: ['a.ts'], untracked: false })
    expect(pendingChanges(`git commit -m "$(cat <<'EOF'\nfix: x\n\n본문 a.ts\nEOF\n)"`)).toBeUndefined()
    // commit 뒤의 add 는 이번 커밋과 무관하다.
    expect(pendingChanges('git commit -m "fix: x" && git add b.ts')).toBeUndefined()
  })

  test('commit 앞의 heredoc 은 메시지가 아니다', () => {
    expect(commitMessage(`cat > a.ts <<'EOF'\n// 주석\nEOF\ngit add a.ts && git commit -m "fix: a"`)).toBe('fix: a')
  })
})
