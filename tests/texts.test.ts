import { describe, expect, test } from 'claude-code/testing'
import { textSources, sourceText } from '../hooks/texts'
import { judge } from '../hooks/guard'
import type { GuardHost } from '../hooks/guard'

function host(files: Record<string, string> = {}): GuardHost {
  return { ui: { toast: () => {} }, process: { run: async argv => {
    if (argv[0] === 'cat') {
      const value = files[argv.at(-1)!]
      return { exitCode: value === undefined ? 1 : 0, stdout: value ?? '' }
    }
    if (argv[0] === 'printenv') return { exitCode: 0, stdout: '/home/test' }
    return { exitCode: 0, stdout: '' }
  } } }
}
const off = { provider: 'off', model: '', url: '' } as const

describe('GitHub·Jira 문체 검사', () => {
  for (const [command, label] of [
    ['gh issue create -t "획기적"', '이슈 제목'],
    ['gh issue edit 1 --body=획기적', '이슈 본문'],
    ['gh pr edit 1 -t "획기적"', 'PR 제목'],
    ['gh issue comment 1 -b "획기적"', '이슈 댓글'],
    ['gh pr comment 1 --edit-last --body "획기적"', 'PR 댓글'],
    ['gh pr review 1 --request-changes -b "획기적"', 'PR 리뷰'],
    ['gh release create v1 -t "획기적"', '릴리즈 제목'],
    ['gh release edit v1 -n "획기적"', '릴리즈 노트'],
    ['acli jira workitem create -s "획기적" --project T --type Task', 'Jira 제목'],
    ['acli jira workitem edit --key T-1 -d "획기적"', 'Jira 본문'],
    ['acli jira workitem comment create --key T-1 -b "획기적"', 'Jira 댓글'],
    ['acli jira workitem comment update --key T-1 --id 1 --body "획기적"', 'Jira 댓글'],
  ]) {
    test(`${label}: ${command}`, async () => {
      expect(await judge(host(), off, command!)).toContain(`[${label}]`)
      expect(await judge(host(), off, command!)).toContain('획기적')
      expect(await judge(host(), off, command!.replace('획기적', '캐시 수정'))).toBeUndefined()
    })
  }

  test('파일·변수·홈 경로·heredoc을 검사한다', async () => {
    const files = { '/body.txt': '획기적', '/home/test/body.txt': '획기적' }
    for (const command of [
      'gh issue edit 1 --body-file /body.txt',
      'gh pr review 1 -F /body.txt',
      'gh release create v1 --notes-file /body.txt',
      'F=/body.txt; gh issue comment 1 -F "$F"',
      'acli jira workitem edit --description-file ~/body.txt',
      'acli jira workitem create --from-file /body.txt',
      'gh issue create --body "$(cat <<\'EOF\'\n획기적\nEOF\n)"',
    ]) expect(await judge(host(files), off, command)).toContain('획기적')
    expect(await judge(host(), off, 'gh issue create -F "$UNKNOWN"')).toContain('셸 변수')
    expect(await judge(host(), off, 'gh release edit v1 -F -')).toContain('표준 입력')
    expect(await judge(host(), off, 'gh issue create -F /missing')).toContain('읽을 수 없다')
  })

  test('ADF·JSON은 텍스트만 검사하고 코드·메타데이터는 제외한다', async () => {
    const adf = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '획' }, { type: 'text', text: '기적' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: '완벽하게' }] },
    ] }
    expect(sourceText(JSON.stringify(adf), 'adf').trim()).toBe('획기적')
    const json = JSON.stringify({ summary: '캐시 수정', description: adf, projectKey: '우아하게' })
    const result = await judge(host({ '/ticket.json': json }), off, 'acli jira workitem create --from-json /ticket.json')
    expect(result).toContain('획기적')
    expect(result).not.toContain('완벽하게')
    expect(result).not.toContain('우아하게')
    expect(await judge(host({ '/comment.json': JSON.stringify(adf) }), off,
      'acli jira workitem comment update --key T-1 --id 1 --body-adf /comment.json')).toContain('획기적')
    expect(await judge(host({ '/bad.json': '{' }), off,
      'acli jira workitem edit --from-json /bad.json')).toContain('JSON 파일')
    expect(await judge(host(), off, `acli jira workitem create --description '${JSON.stringify(adf)}'`)).toContain('획기적')
  })

  test('본문 속 명령·플래그와 조회 명령을 검사 대상으로 오인하지 않는다', async () => {
    for (const command of [
      'echo "gh issue create --body 획기적"',
      'gh issue view 1', 'gh pr list', 'acli jira workitem view T-1',
      'gh release create v1 --generate-notes', 'gh issue create --editor',
      'gh issue edit 1 --add-label 획기적', 'acli jira workitem edit --key T-1 --assignee 획기적',
    ]) expect(textSources(command)).toEqual([])
    expect(textSources('gh pr create --body "example --title 획기적"')).toEqual([
      { label: 'PR 본문', text: 'example --title 획기적', file: undefined, format: undefined },
    ])
    const result = await judge(host(), off, 'gh issue create --title "캐시"; gh pr comment 1 --body "획기적"; git commit -m "우아하게"')
    expect(result).toContain('[PR 댓글]')
    expect(result).toContain('[커밋 메시지]')
    expect(result).not.toContain('[이슈 제목]')
    expect(await judge(host(), off, 'gh issue create --body "캐시" --body 획기적')).toContain('획기적')
    expect(await judge(host(), off, 'gh issue create --body "획기적" --body "캐시"')).toBeUndefined()
  })
})
