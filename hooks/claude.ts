import type { Register } from 'claude-code'
import { judge } from './guard'
import type { Ollama } from './guard'

export const register: Register = (on, options) => {
  const ollama: Ollama = { url: String(options.ollamaUrl ?? ''), model: String(options.ollamaModel ?? '').trim() }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const host = {
      process: { run: (argv: string[], init?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, init) },
      ui: { toast: (message: string) => $.ui.toast(message) },
    }
    const reason = await judge(host, ollama, e.command)
    return reason ? { deny: `ko-tone-guard: ${reason}` } : next(e)
  }).catch(($, e, next) => {
    // 문체 검사기의 오류로 작업을 멈추지 않는다.
    if (!next.called) $.ui.toast('ko-tone-guard: 검사 중 오류가 나 이번 명령은 검사하지 않았다')
    return next(e)
  })
}
