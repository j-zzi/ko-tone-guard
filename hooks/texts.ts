import { codeOnly, flagFile, flagValue } from './parse'

export type TextSource = { label: string; text?: string; file?: string; format?: 'adf' | 'jira-json' }

// 각 명령의 인자만 읽어, 다른 명령이나 본문 속 플래그를 섞지 않는다.
export function textSources(command: string): TextSource[] {
  const code = codeOnly(command)
  const re = /\b(?:gh\s+(pr|issue|release)\s+(create|edit|comment|review)|acli\s+jira\s+workitem\s+(create|edit|comment\s+(?:create|update)))\b/g
  const sources: TextSource[] = []
  for (const match of code.matchAll(re)) {
    const start = match.index!
    const offset = start + match[0].length
    const boundary = code.slice(offset).search(/[;&|\n]/)
    const part = command.slice(start, boundary < 0 ? undefined : offset + boundary)
    const add = (label: string, flags: string, fileFlags?: string, format?: TextSource['format']) => {
      const text = flagValue(part, flags)
      const file = fileFlags ? flagFile(part, fileFlags, command) : undefined
      if (text !== undefined || file !== undefined) sources.push({ label, text, file, format })
    }
    if (match[3]) {
      if (match[3].startsWith('comment')) {
        add('Jira 댓글', '--body|-b', '--body-file|-F|--body-adf', 'adf')
      } else {
        add('Jira 제목', '--summary|-s')
        add('Jira 본문', '--description|-d', '--description-file', 'adf')
        const json = flagFile(part, '--from-json', command)
        if (json !== undefined) sources.push({ label: 'Jira 티켓', file: json, format: 'jira-json' })
        const file = flagFile(part, '--from-file|-f', command)
        if (file !== undefined) sources.push({ label: 'Jira 티켓', file, format: 'adf' })
      }
    } else {
      const kind = match[1]!
      const action = match[2]!
      if (kind === 'release') {
        if (!['create', 'edit'].includes(action)) continue
        add('릴리즈 제목', '--title|-t')
        add('릴리즈 노트', '--notes|-n', '--notes-file|-F')
      } else if (action === 'review') {
        if (kind === 'pr') add('PR 리뷰', '--body|-b', '--body-file|-F')
      } else if (action === 'comment') {
        add(kind === 'pr' ? 'PR 댓글' : '이슈 댓글', '--body|-b', '--body-file|-F')
      } else {
        const label = kind === 'pr' ? 'PR' : '이슈'
        add(`${label} 제목`, '--title|-t')
        add(`${label} 본문`, '--body|-b', '--body-file|-F')
      }
    }
  }
  return sources
}

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[]; marks?: { type?: string }[] }
  if (n.type === 'codeBlock' || n.marks?.some(m => m.type === 'code')) return ''
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  const text = Array.isArray(n.content) ? n.content.map(adfText).join('') : ''
  return ['paragraph', 'heading', 'listItem', 'tableCell'].includes(n.type ?? '') ? text + '\n' : text
}

export function sourceText(value: string, format?: TextSource['format']): string {
  if (!format) return value
  if (format === 'jira-json') {
    const item = JSON.parse(value) as { summary?: string; description?: unknown; fields?: { summary?: string; description?: unknown } }
    const fields = item.fields ?? item
    return [fields.summary, typeof fields.description === 'string'
      ? sourceText(fields.description, 'adf') : adfText(fields.description)].filter(Boolean).join('\n\n')
  }
  try {
    const doc = JSON.parse(value)
    return doc?.type === 'doc' ? adfText(doc) : value
  } catch {
    return value
  }
}
