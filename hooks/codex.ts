import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { judge } from './guard'
import type { GuardHost } from './guard'
import { checkerConfig } from './checker'

// 훅 프로세스 사이에 같은 세션의 soft 경고를 유지한다.
async function main() {
  if (process.env.KO_TONE_GUARD_INTERNAL === '1') return
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const event = JSON.parse(input)
  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Bash') return
  const command = event.tool_input?.command ?? event.tool_input?.cmd
  if (typeof command !== 'string') return
  const notices: string[] = []
  const host: GuardHost = {
    ui: { toast: message => { notices.push(message) } },
    process: {
      run: (argv, init) => new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
          cwd: event.tool_input?.workdir ?? event.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: init?.timeoutMs ?? 15_000,
        })
        let stdout = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.resume()
        child.on('error', reject)
        child.on('close', code => resolve({ exitCode: code ?? 1, stdout }))
        child.stdin.on('error', () => {})
        child.stdin.end(init?.stdin)
      }),
    },
  }
  let reason = await judge(host, checkerConfig(
    process.env.KO_TONE_GUARD_MODEL ?? '',
    process.env.KO_TONE_GUARD_BASE_URL?.trim() || process.env.KO_TONE_GUARD_OLLAMA_URL?.trim() || 'http://localhost:11434',
    process.env.KO_TONE_GUARD_OLLAMA_MODEL ?? '',
  ), command)
  if (reason?.startsWith('문체 경고(오탐 가능)')) {
    const key = createHash('sha256').update(`${event.session_id ?? event.cwd}\n${command}\n${reason}`).digest('hex')
    const dir = process.env.PLUGIN_DATA ?? join(tmpdir(), 'ko-tone-guard')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, key)
    const alreadyWarned = await readFile(file, 'utf8').then(() => true, () => false)
    if (alreadyWarned) reason = undefined
    else await writeFile(file, '', { mode: 0o600 })
  }
  const output = reason
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `ko-tone-guard: ${reason}` } }
    : notices.length ? { systemMessage: notices.join('\n') } : {}
  process.stdout.write(JSON.stringify(output))
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ systemMessage: 'ko-tone-guard: 검사 중 오류가 나 이번 명령은 검사하지 않았다' }))
})
