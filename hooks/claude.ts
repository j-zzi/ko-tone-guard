import type { Register } from 'claude-code'
import { judge } from './guard'
import { checkerConfig } from './checker'

export const register: Register = (on, options) => {
  const selection = String(options.checkerModel ?? '')
  const url = String(options.ollamaUrl ?? 'http://localhost:11434')
  const legacyModel = String(options.ollamaModel ?? '')

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (await $.env.get('KO_TONE_GUARD_INTERNAL') === '1') return next(e)
    const host = {
      process: { run: (argv: string[], init?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, init) },
      ui: { toast: (message: string) => $.ui.toast(message) },
    }
    const reason = await judge(host, checkerConfig(selection, url, legacyModel), e.command)
    return reason ? { deny: `ko-tone-guard: ${reason}` } : next(e)
  }).catch(($, e, next) => {
    // 문체 검사기의 오류로 작업을 멈추지 않는다.
    if (!next.called) $.ui.toast('ko-tone-guard: 검사 중 오류가 나 이번 명령은 검사하지 않았다')
    return next(e)
  })
}
