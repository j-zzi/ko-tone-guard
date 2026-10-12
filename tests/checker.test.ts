import { describe, expect, test } from 'claude-code/testing'
import { checkerConfig, checkerIssues } from '../hooks/checker'
import type { GuardHost } from '../hooks/guard'

describe('검사기 선택과 CLI 응답', () => {
  test('접두사로 선택하고 기존 설정은 Ollama로 연결한다', () => {
    expect(checkerConfig('claude:sonnet', 'url', 'old').provider).toBe('claude')
    expect(checkerConfig('codex:gpt-test', 'url').model).toBe('gpt-test')
    expect(checkerConfig('ollama:gemma:test', 'url').model).toBe('gemma:test')
    expect(checkerConfig('', 'url', 'old').provider).toBe('ollama')
    expect(checkerConfig('', 'url').provider).toBe('off')
    expect(checkerConfig('off', 'url', 'old').provider).toBe('off')
    expect(() => checkerConfig('sonnet', 'url')).toThrow()
    expect(() => checkerConfig('claude:', 'url')).toThrow()
  })

  for (const provider of ['claude', 'codex'] as const) {
    test(`${provider} CLI는 모델을 전달하고 원문에 있는 지적만 반환한다`, async () => {
      let argv: string[] = []
      let stdin = ''
      const issues = [{ phrase: '탄탄한 기반', reason: '자평' }, { phrase: '없는 구절', reason: '환각' }]
      const stdout = provider === 'claude'
        ? JSON.stringify({ result: JSON.stringify({ issues }) })
        : JSON.stringify({ type: 'thread.started' }) + '\n' + JSON.stringify({
            type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ issues }) },
          }) + '\n' + JSON.stringify({ type: 'turn.completed' })
      const host: GuardHost = {
        ui: { toast: () => {} },
        process: { run: async (args, init) => {
          argv = args
          stdin = init?.stdin ?? ''
          return { exitCode: 0, stdout }
        } },
      }
      expect(await checkerIssues(host, checkerConfig(`${provider}:selected`, ''), '탄탄한 기반을 마련한다'))
        .toEqual([issues[0]])
      expect(argv).toContain(provider)
      expect(argv[argv.indexOf('--model') + 1]).toBe('selected')
      expect(argv).toContain('KO_TONE_GUARD_INTERNAL=1')
      expect(stdin).toContain('탄탄한 기반을 마련한다')
      if (provider === 'claude') {
        expect(argv).toContain('CLAUDECODE')
        expect(argv[argv.indexOf('--tools') + 1]).toBe('')
        expect(argv).toContain('{"disableAllHooks":true}')
      } else {
        expect(argv).toContain('features.hooks=false')
        expect(argv).toContain('read-only')
      }
    })

    test(`${provider} CLI 실패·잘못된 응답은 검사 실패로 처리한다`, async () => {
      const config = checkerConfig(`${provider}:selected`, '')
      for (const result of [
        { exitCode: 1, stdout: '' },
        { exitCode: 0, stdout: 'not json' },
        { exitCode: 0, stdout: provider === 'claude'
          ? JSON.stringify({ is_error: true, result: '{"issues":[]}' })
          : JSON.stringify({ type: 'turn.failed' }) },
        { exitCode: 0, stdout: provider === 'claude'
          ? JSON.stringify({ result: '{"issues":[{"phrase":"x"}]}' })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"issues":[{"phrase":"x"}]}' } }) },
      ]) {
        const host: GuardHost = { ui: { toast: () => {} }, process: { run: async () => result } }
        expect(await checkerIssues(host, config, 'x')).toBeUndefined()
      }
      const host: GuardHost = { ui: { toast: () => {} }, process: { run: async () => { throw new Error('timeout') } } }
      expect(await checkerIssues(host, config, 'x')).toBeUndefined()
    })
  }
})
