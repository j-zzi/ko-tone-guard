export type GuardHost = {
  process: { run(argv: string[], init?: { stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }> }
  ui: { toast(message: string): void }
}

import { GIT_COMMIT, PR_CREATE, codeOnly, commitMessage, expandHome, hasUnresolvedVar, pendingChanges, prBody, prBodyFile, prTitle, targetDir } from './parse'
import { COMMENT_MAX, TONE_BYPASS, addedComments, chunks, longComments, mergeIssues, overlaps, regexIssues, stripCode } from './tone'
import type { ToneIssue } from './tone'

import { checkerIssues } from './checker'
import type { Checker } from './checker'

async function git($: GuardHost, dir: string | undefined, args: string[]) {
  const r = await $.process.run(dir ? ['git', '-C', dir, ...args] : ['git', ...args])
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

// 훅은 셸 없이 git·cat 을 부르므로 ~ 를 직접 펼친다.
async function resolveHome($: GuardHost, path: string | undefined): Promise<string | undefined> {
  if (!path?.startsWith('~')) return path
  const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  return home ? expandHome(path, home) : path
}

// staged 에 더해, 같은 명령이 커밋에 넣을 변경(작업 트리 수정·새 파일)까지 합친다.
async function commitDiff($: GuardHost, dir: string | undefined, command: string) {
  const cached = await git($, dir, ['diff', '--cached', '-U0', '--no-color'])
  const pending = pendingChanges(command)
  if (!pending) return cached
  const scope = pending.all ? [] : ['--', ...pending.paths]
  const unstaged = await git($, dir, ['diff', '-U0', '--no-color', ...scope])
  const parts = [cached, unstaged]
  if (pending.untracked) {
    const files = ((await git($, dir, ['ls-files', '--others', '--exclude-standard', ...scope])) ?? '').split('\n').filter(Boolean)
    for (const f of files.slice(0, 50)) {
      // --no-index 는 차이가 있으면 exit 1 이라 git() 을 거치지 않는다.
      const r = await $.process.run([...(dir ? ['git', '-C', dir] : ['git']), 'diff', '--no-index', '-U0', '--no-color', '/dev/null', f])
      parts.push(r.stdout)
    }
  }
  return parts.filter(Boolean).join('\n')
}

// hard 는 매번, soft(LLM 정밀도 절반) 는 한 번만 막는다.
async function toneProblems($: GuardHost, checker: Checker, sources: { label: string; text: string | undefined }[]) {
  const hard: string[] = []
  const soft: string[] = []
  let llmUp = checker.provider !== 'off'
  const deadline = Date.now() + 90_000
  for (const { label, text } of sources) {
    if (!text?.trim()) continue
    const clean = stripCode(text)
    const byRegex = mergeIssues(regexIssues(clean), clean)
    const byLlm: ToneIssue[] = []
    for (const chunk of llmUp ? chunks(clean) : []) {
      const remaining = deadline - Date.now()
      const r = remaining > 0 ? await checkerIssues($, checker, chunk, Math.min(65_000, remaining)) : undefined
      if (r === undefined) {
        llmUp = false
        // 막지는 않되(fail-open), LLM 검사가 빠졌다는 사실은 보이게 한다.
        $.ui.toast(`ko-tone-guard: ${checker.provider === 'ollama' ? 'Ollama' : checker.provider} 응답 실패 — 모델 검사 없이 정규식·긴 주석 검사를 계속한다`)
        break
      }
      byLlm.push(...r)
    }
    const known = (i: ToneIssue) => byRegex.some(k => overlaps(clean, k.phrase, i.phrase))
    for (const i of byRegex) hard.push(`- [${label}] "${i.phrase}" — ${i.reason}`)
    for (const i of mergeIssues(byLlm.filter(i => !known(i)), clean)) soft.push(`- [${label}] "${i.phrase}" — ${i.reason}`)
  }
  return { hard, soft }
}

// 모듈 변수라 reload 되면 비워진다 — 그때는 한 번 더 경고할 뿐이다.
const warned = new Set<string>()

function toneVerdict(command: string, { hard, soft }: { hard: string[]; soft: string[] }) {
  if (hard.length > 0) {
    return `문체 검사 지적 — 해당 표현을 담백한 평서문으로 고쳐 다시 실행하라. 오탐이라고 판단되면 사용자에게 확인받은 뒤에만 명령 앞에 \`${TONE_BYPASS}\` 를 붙인다:\n${[...hard, ...soft].join('\n')}`
  }
  if (soft.length === 0) return undefined
  const key = `${command}\n${soft.join('\n')}`
  if (warned.has(key)) return undefined
  warned.add(key)
  return `문체 경고(오탐 가능) — 맞는 지적이면 고쳐서 다시 실행하고, 오탐이면 같은 명령을 그대로 다시 실행하면 통과한다:\n${soft.join('\n')}`
}

const UNRESOLVED = '경로에 셸 변수가 남아 있어 검사할 저장소·파일을 확인할 수 없다 — 리터럴 경로로 다시 실행하라.'

export async function judge($: GuardHost, checker: Checker, command: string): Promise<string | undefined> {
  if (command.includes(TONE_BYPASS)) return undefined
  const code = codeOnly(command)
  if (PR_CREATE.test(code)) {
    const file = await resolveHome($, prBodyFile(command))
    if (hasUnresolvedVar(file)) return UNRESOLVED
    const body = file ? (await $.process.run(['cat', file])).stdout : prBody(command)
    const problems = await toneProblems($, checker, [
      { label: 'PR 제목', text: prTitle(command) },
      { label: 'PR 본문', text: body },
    ])
    return toneVerdict(command, problems)
  }
  if (!GIT_COMMIT.test(code)) return undefined

  const dir = await resolveHome($, targetDir(command))
  if (hasUnresolvedVar(dir)) return UNRESOLVED
  const diff = await commitDiff($, dir, command)
  const tone = await toneProblems($, checker, [
    { label: '커밋 메시지', text: commitMessage(command) },
    { label: '추가된 주석', text: diff && addedComments(diff) },
  ])
  const long = diff ? longComments(diff) : []
  for (const l of long) tone.soft.push(`- [긴 주석 · 한도 ${COMMENT_MAX.lines}줄·${COMMENT_MAX.words}어절] ${l}`)
  return toneVerdict(command, tone)
}

