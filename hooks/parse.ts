// 순수 함수만 둔다 — 명령 문자열에서 가드 판단에 필요한 조각을 뽑는다.

// git 과 commit 사이의 전역 옵션(-C, -c k=v, --no-pager …) — 빠뜨리면 가드 전체를 건너뛴다.
const GIT_OPT = `(?:-[Cc]\\s+(?:"[^"]+"|'[^']+'|\\S+)|--?[A-Za-z][\\w-]*(?:=\\S+)?)`
export const GIT_COMMIT = new RegExp(`\\bgit\\s+(?:${GIT_OPT}\\s+)*commit\\b`)

// heredoc 본문·따옴표 안은 실행되지 않는 텍스트라, 그 안의 git 명령을 실제 명령으로 읽지 않도록 길이를 유지한 채 비운다.
// sh -c · eval 은 문자열 자체가 실행되므로 비우지 않는다.
export function codeOnly(command: string): string {
  const noHeredoc = command.replace(
    /(<<-?\s*['"]?(\w+)['"]?[^\n]*\n)([\s\S]*?)(\n\s*\2\b)/g,
    (_, open: string, _tag, body: string, close: string) => open + body.replace(/[^\n]/g, ' ') + close,
  )
  // 본문 속 bash -c 예시는 무시하고, 셸에 넘기는 heredoc 은 본문을 명령으로 본다.
  if (/\b(?:ba|z)?sh\s+-c\b|\beval\b/.test(noHeredoc) || /^(?=[^\n]*<<)[^\n]*(?:^|[\s|;&(])(?:ba|z)?sh\b/m.test(noHeredoc)) return command
  // 짝이 안 맞는 따옴표는 어디까지가 문자열인지 알 수 없다 — 비우지 않아야 뒤의 실제 명령을 놓치지 않는다.
  return maskQuotes(noHeredoc) ?? noHeredoc
}

// 셸처럼 왼쪽부터 훑어야 \' 같은 이스케이프와 # 주석 안의 따옴표를 짝으로 오인하지 않는다.
function maskQuotes(s: string): string | undefined {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      out += s.slice(i, i + 2)
      i += 2
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      const end = s.indexOf('\n', i)
      const j = end < 0 ? s.length : end
      out += ' '.repeat(j - i)
      i = j
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== c) j += c === '"' && s[j] === '\\' ? 2 : 1
      if (j >= s.length) return undefined
      out += c + ' '.repeat(j - i - 1) + c
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

// 위치는 codeOnly 로 찾고 값은 원문에서 읽는다 — 두 문자열은 길이가 같다.
function matchCode(command: string, re: RegExp): RegExpMatchArray | null {
  const at = codeOnly(command).match(re)
  if (!at) return null
  const m = command.slice(at.index).match(re)
  if (m) m.index = at.index! + m.index!
  return m
}

const QUOTED = `(?:"([^"]+)"|'([^']+)'|(\\S+))`

// 훅은 셸이 변수를 펼치기 전 문자열을 본다 — 같은 명령 안의 대입만 풀고, 못 푼 변수는 남겨 호출자가 막는다.
function expandVars(command: string, value: string): string {
  const vars = new Map<string, string>()
  for (const m of command.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g)) {
    vars.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? '')
  }
  return value.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (s, n: string) => vars.get(n) ?? s)
}

export function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=\/|$)/, home)
}

// ~user 처럼 홈으로 풀 수 없는 ~ 도 남은 것으로 본다.
export function hasUnresolvedVar(path: string | undefined): boolean {
  return path !== undefined && (path.includes('$') || path.startsWith('~'))
}

// Bash 도구의 cwd 는 호출 사이에 유지되어 mod 가 알 수 없다 — 명령에 적힌 경로만 믿는다.
export function targetDir(command: string): string | undefined {
  const m =
    matchCode(command, new RegExp(`\\bgit\\s+(?:${GIT_OPT}\\s+)*?-C\\s+${QUOTED}`)) ??
    matchCode(command, new RegExp(`^(?:\\s*[A-Za-z_]\\w*=\\S*\\s*;)*\\s*cd\\s+${QUOTED}\\s*&&`))
  return m ? expandVars(command, m[1] ?? m[2] ?? m[3]!) : undefined
}

export function commitMessage(command: string): string | undefined {
  // 파일을 만드는 앞쪽 heredoc 을 메시지로 오인하지 않도록 commit 뒤만 본다.
  const at = matchCode(command, GIT_COMMIT)
  const tail = at ? command.slice(at.index! + at[0].length) : command
  const heredoc = tail.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/)
  if (heredoc) return heredoc[2]

  const parts: string[] = []
  // -am 처럼 묶인 짧은 플래그도 메시지다 — 놓치면 문체 검사를 통째로 건너뛴다.
  const re = /(?:^|\s)-[A-Za-z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g
  for (const m of tail.matchAll(re)) {
    parts.push(m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, '$1') : (m[2] ?? ''))
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export type Pending = { all: boolean; paths: string[]; untracked: boolean }

const COMMIT_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '-t', '--message', '--file', '--author', '--date', '--template',
  '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer',
])

function words(s: string): string[] {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

function firstCommand(s: string): string {
  return s.split(/&&|\|\||[;|\n]/)[0] ?? ''
}

// 훅은 명령 실행 전에 돌아, 같은 명령의 git add · commit -a · commit <경로> 는 아직 staged 에 없다.
export function pendingChanges(command: string): Pending | undefined {
  const at = matchCode(command, GIT_COMMIT)
  if (!at) return undefined
  const pending: Pending = { all: false, paths: [], untracked: false }

  const head = command.slice(0, at.index)
  for (const m of codeOnly(head).matchAll(new RegExp(`\\bgit\\s+(?:${GIT_OPT}\\s+)*add\\b`, 'g'))) {
    const args = words(firstCommand(head.slice(m.index + m[0].length)))
    const update = args.some(a => a === '-u' || a === '--update')
    if (update || args.some(a => ['.', ':/', '-A', '--all'].includes(a))) pending.all = true
    pending.paths.push(...args.filter(a => !a.startsWith('-') && a !== '.' && a !== ':/'))
    if (!update) pending.untracked = true
  }

  // 메시지 안의 공백·heredoc 을 경로로 읽지 않도록 따옴표 구간을 먼저 지운다.
  const tail = firstCommand(command.slice(at.index! + at[0].length).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q'))
  const args = tail.split(/\s+/).filter(Boolean)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      pending.paths.push(...args.slice(i + 1))
      break
    }
    if (a === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/.test(a)) pending.all = true
    if (COMMIT_VALUE_FLAGS.has(a) || /^-[A-Za-z]*[mFCct]$/.test(a)) i++
    else if (!a.startsWith('-')) pending.paths.push(a)
  }

  return pending.all || pending.paths.length > 0 ? pending : undefined
}

export const PR_CREATE = /\bgh\s+pr\s+create\b/

function flagValue(command: string, flags: string): string | undefined {
  const heredoc = command.match(
    new RegExp(`(?:^|\\s)(?:${flags})\\s+"\\$\\(cat\\s+<<-?\\s*['"]?(\\w+)['"]?\\s*\\n([\\s\\S]*?)\\n\\s*\\1\\b`),
  )
  if (heredoc) return heredoc[2]
  const m = command.match(new RegExp(`(?:^|\\s)(?:${flags})(?:\\s+|=)(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`))
  if (!m) return undefined
  return m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, '$1') : m[2]
}

export function prTitle(command: string): string | undefined {
  return flagValue(command, '--title|-t')
}

export function prBody(command: string): string | undefined {
  return flagValue(command, '--body|-b')
}

export function prBodyFile(command: string): string | undefined {
  const m = command.match(new RegExp(`(?:^|\\s)(?:--body-file|-F)(?:\\s+|=)${QUOTED}`))
  return m ? expandVars(command, m[1] ?? m[2] ?? m[3]!) : undefined
}
