// 문체 검사의 순수 부분 — 모델 호출은 checker.ts가 한다.

export type ToneIssue = { phrase: string; reason: string }

export const TONE_BYPASS = 'KO_TONE_GUARD=off'

// 기술 문장에서도 쓰이는 말(보장, 강력한 일관성 등)은 오탐이 나서 넣지 않는다 — 나머지는 LLM 몫.
const PATTERNS: [RegExp, string][] = [
  [/획기적/, '과장'],
  [/게임\s?체인저/, '과장'],
  [/load-bearing/i, '비유적 유행어'],
  [/seamless/i, '비유적 유행어'],
  [/좋은 질문/, '맞장구'],
  [/완벽하게/, '과장'],
  [/견고한/, '근거 없는 수식'],
  [/우아하게/, '근거 없는 자평'],
  [/진정한/, '거창한 틀'],
  [/한 차원/, '과장'],
  [/극대화/, '과장'],
  [/단순히 [^.\n]{1,40}?아니라/, '거창한 틀'],
  // "선다" 와 일반 "에 있어서"는 정상 용법(줄이 선다, 캐시에 있어서)과 겹쳐 LLM 몫으로 둔다.
  [/(?:운영|정산|설계|구현)에 있어서?/, '직역체'],
  [/에 의해/, '직역체'],
  [/것이 가능(?:하|한)/, '직역체'],
  [/[을를] 가지고 있/, '직역체'],
  [/[함됨]으로써/, '직역체'],
  [/영향을 (?:갖|가지|가진)/, '직역체'],
  [/수도 있을 가능성/, '겹친 단서'],
]

export function regexIssues(text: string): ToneIssue[] {
  return PATTERNS.flatMap(([re, reason]) => {
    const m = text.match(re)
    return m ? [{ phrase: m[0], reason }] : []
  })
}

// 코드는 문체 검사 대상이 아니고, 섞이면 모델이 식별자를 지적한다.
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '`…`')
}

// 긴 입력을 한 번에 넣으면 시스템 프롬프트의 예시를 지어내 지적했다(qwen2.5 실측) — 문단 단위로 자른다.
export function chunks(text: string, max = 1200): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length > max) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n\n${para}` : para
  }
  if (cur.trim()) out.push(cur)
  return out
}

const COMMENT_FILE = /\.(?:[cm]?[jt]sx?|sh|sql|py|ya?ml)$/
const COMMENT_LINE = /^\+\s*(?:\/\/+|\/\*+|\*|#|--)\s?(.*)$/
const DIRECTIVE = /^(?:!|eslint|@ts-|prettier-ignore|istanbul|c8 )/

type CommentBlock = { file: string; lines: string[] }

// 연속된 추가 주석 줄을 한 블록으로 묶는다.
export function commentBlocks(diff: string): CommentBlock[] {
  let file = ''
  const blocks: CommentBlock[] = []
  let cur: CommentBlock | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '')
      cur = undefined
      continue
    }
    const m = COMMENT_FILE.test(file) ? line.match(COMMENT_LINE) : null
    if (!m) {
      cur = undefined
      continue
    }
    const body = m[1]?.replace(/\*\/\s*$/, '').replace(/^\/$/, '').trim() ?? ''
    if (!body) continue
    if (DIRECTIVE.test(body)) {
      cur = undefined
      continue
    }
    if (!cur) blocks.push((cur = { file, lines: [] }))
    cur.lines.push(body)
  }
  return blocks
}

export function addedComments(diff: string): string {
  return commentBlocks(diff)
    .flatMap(b => b.lines)
    .filter(l => l.length >= 6)
    .join('\n')
}

export const COMMENT_MAX = { lines: 2, words: 15 }

export function longComments(diff: string): string[] {
  return commentBlocks(diff).flatMap(({ file, lines }) => {
    const words = lines.join(' ').split(/\s+/).length
    if (lines.length <= COMMENT_MAX.lines && words <= COMMENT_MAX.words) return []
    const head = lines[0]!.length > 40 ? `${lines[0]!.slice(0, 40)}…` : lines[0]
    return [`${file}: "${head}" — ${lines.length}줄·${words}어절`]
  })
}

export const TONE_SYSTEM = `너는 한국어 기술 문서(PR 본문, 커밋 메시지, 코드 주석)의 문체 검사기다. 글을 고쳐 쓰지 말고, 아래에 해당하는 표현만 찾아라.

찾을 것 (AI 가 쓴 티가 나는 표현):
- 과장·최상급·홍보 문구: 획기적, 완벽하게, 강력한, 견고한, 게임 체인저, 크게 향상
- 근거 없는 자평: 깔끔하게, 우아하게, 원활하게
- 거창한 틀: "핵심은 ~", "단순히 A 가 아니라 B", "진정한 ~", "본질은", "주목할 점은", "요약하면"
- 비유적 영어 유행어: load-bearing, seamless
- 겹겹이 쌓은 단서: "경우에 따라 ~일 수도 있을 가능성"
- 아첨·맞장구: "좋은 질문입니다", "말씀하신 대로"
- 영어를 옮긴 직역체: "정책이 선다"(→적용된다), "쿼리가 선다"(→실행된다), "운영에 있어서", "필수적인 요소이다", "~에 의해 처리된다", "~를 가지고 있다"

찾지 말 것:
- 사실을 서술하는 기술 용어 ("순서가 보장되지 않는다", "fail-open", "교착")
- 코드·명령·에러 코드·숫자
- 간결한 개조식, 대시(—)를 쓴 짧은 설명

해당 표현이 없으면 빈 배열을 돌려라. 확신이 없으면 넣지 마라.`

export const TONE_FORMAT = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { phrase: { type: 'string' }, reason: { type: 'string' } },
        required: ['phrase', 'reason'],
      },
    },
  },
  required: ['issues'],
}

export function ollamaBody(text: string, model: string): string {
  return JSON.stringify({
    model,
    stream: false,
    think: false,
    format: TONE_FORMAT,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: TONE_SYSTEM },
      { role: 'user', content: text },
    ],
  })
}

// 원문에 없는 구절은 모델이 지어낸 것이라 버린다.
export function parseOllama(stdout: string, source: string): ToneIssue[] {
  try {
    const j = JSON.parse(stdout) as { message?: { content?: string } }
    const { issues } = JSON.parse(j.message?.content ?? '') as { issues?: ToneIssue[] }
    return (issues ?? [])
      .filter(i => typeof i.phrase === 'string')
      // "핵심은 ~" 처럼 틀만 돌려주기도 해서 꼬리의 ~ 를 떼고 대조한다.
      .map(i => ({ ...i, phrase: i.phrase.replace(/\s*~\s*$/, '') }))
      .filter(i => i.phrase.length > 0 && source.includes(i.phrase))
  } catch {
    return []
  }
}

// "를 가지고 있" 과 "가지고 있다" 처럼 서로 포함하지 않아도 원문 위치가 겹치면 같은 지적이다.
export function overlaps(source: string, a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true
  const i = source.indexOf(a)
  const j = source.indexOf(b)
  return i >= 0 && j >= 0 && i < j + b.length && j < i + a.length
}

export function mergeIssues(issues: ToneIssue[], source: string): ToneIssue[] {
  const kept: ToneIssue[] = []
  for (const i of issues) {
    if (!kept.some(k => overlaps(source, k.phrase, i.phrase))) kept.push(i)
  }
  return kept
}
