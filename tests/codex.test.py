import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HOOK = Path(os.environ.get('KO_TONE_GUARD_TEST_ROOT', Path(__file__).resolve().parents[1])) / 'hooks/codex.ts'


class CodexHookTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)

    def hook(self, command, session='test', env_overrides=None, **fields):
        event = dict(hook_event_name='PreToolUse', tool_name='Bash', cwd=str(self.repo),
                     session_id=session, tool_input=dict(command=command))
        event.update(fields)
        env = dict(os.environ, KO_TONE_GUARD_MODEL='off', KO_TONE_GUARD_INTERNAL='',
                   KO_TONE_GUARD_OLLAMA_MODEL='', PLUGIN_DATA=str(self.repo / 'data'))
        env.update(env_overrides or {})
        result = subprocess.run(['bun', 'run', str(HOOK)], input=json.dumps(event), text=True,
                                capture_output=True, check=True, env=env)
        return json.loads(result.stdout or '{}')

    def denied(self, result):
        self.assertEqual(result['hookSpecificOutput']['permissionDecision'], 'deny')
        return result['hookSpecificOutput']['permissionDecisionReason']

    def test_commit_blocks_on_every_attempt(self):
        for _ in range(2):
            self.assertIn('획기적', self.denied(self.hook('git commit -m "획기적인 변경"')))

    def test_plain_commit_and_unrelated_command(self):
        self.assertEqual(self.hook('git commit -m "캐시 만료 시간 수정"'), {})
        self.assertEqual(self.hook('echo 획기적'), {})

    def test_staged_comments(self):
        (self.repo / 'a.ts').write_text('// 획기적인 캐시\n')
        self.git('add', 'a.ts')
        self.assertIn('추가된 주석', self.denied(self.hook('git commit -m "캐시 수정"')))

    def test_pending_add(self):
        (self.repo / 'a.ts').write_text('// 획기적인 캐시\n')
        self.assertIn('추가된 주석', self.denied(self.hook('git add a.ts && git commit -m "캐시 수정"')))

    def test_warning_survives_process_restart_and_is_session_scoped(self):
        (self.repo / 'a.ts').write_text('// 첫 번째 설명\n// 두 번째 설명\n// 세 번째 설명\n')
        self.git('add', 'a.ts')
        command = 'git commit -m "주석 수정"'
        self.assertIn('긴 주석', self.denied(self.hook(command)))
        self.assertEqual(self.hook(command), {})
        self.denied(self.hook(command, session='another'))

    def test_pr_title_and_body(self):
        self.assertIn('PR 제목', self.denied(self.hook('gh pr create --title "획기적인 변경" --body "설명"')))
        self.assertIn('PR 본문', self.denied(self.hook('gh pr create --title "변경" --body "획기적인 설명"')))

    def test_pr_body_file(self):
        body = self.repo / 'body.md'
        body.write_text('획기적인 설명')
        self.assertIn('PR 본문', self.denied(self.hook(f'gh pr create --title "변경" --body-file "{body}"')))

    def test_github_and_jira_writes(self):
        for command, label in [
            ('gh issue create -t "획기적"', '이슈 제목'),
            ('gh issue edit 1 -b "획기적"', '이슈 본문'),
            ('gh pr edit 1 -t "획기적"', 'PR 제목'),
            ('gh issue comment 1 -b "획기적"', '이슈 댓글'),
            ('gh pr comment 1 -b "획기적"', 'PR 댓글'),
            ('gh pr review 1 -b "획기적"', 'PR 리뷰'),
            ('gh release create v1 -t "획기적"', '릴리즈 제목'),
            ('gh release edit v1 -n "획기적"', '릴리즈 노트'),
            ('acli jira workitem create --summary "획기적"', 'Jira 제목'),
            ('acli jira workitem edit --key T-1 -d "획기적"', 'Jira 본문'),
            ('acli jira workitem comment create --key T-1 -b "획기적"', 'Jira 댓글'),
            ('acli jira workitem comment update --key T-1 --id 1 -b "획기적"', 'Jira 댓글'),
        ]:
            with self.subTest(command=command):
                self.assertIn(label, self.denied(self.hook(command)))
                self.assertEqual(self.hook(command.replace('획기적', '캐시 수정')), {})

    def test_jira_json_and_adf_files(self):
        adf = dict(type='doc', version=1, content=[dict(type='paragraph', content=[dict(type='text', text='획기적')])])
        body = self.repo / 'body.json'
        body.write_text(json.dumps(adf))
        self.assertIn('Jira 댓글', self.denied(self.hook(f'acli jira workitem comment update --body-adf "{body}"')))
        ticket = self.repo / 'ticket.json'
        ticket.write_text(json.dumps(dict(summary='캐시 수정', description=adf)))
        self.assertIn('획기적', self.denied(self.hook(f'acli jira workitem create --from-json "{ticket}"')))
        self.assertIn('Jira 본문', self.denied(self.hook(f'acli jira workitem edit --description-file "{body}"')))
        self.assertIn('표준 입력', self.denied(self.hook('gh issue comment 1 --body-file -')))

    def test_workdir(self):
        (self.repo / 'a.ts').write_text('// 획기적인 캐시\n')
        self.git('add', 'a.ts')
        self.denied(self.hook('', cwd='/tmp', tool_input=dict(command='git commit -m "캐시 수정"', workdir=str(self.repo))))

    def test_unresolved_path(self):
        self.assertIn('셸 변수', self.denied(self.hook('git -C "$DIR" commit -m "수정"')))

    def test_bypass(self):
        self.assertEqual(self.hook('KO_TONE_GUARD=off git commit -m "획기적"'), {})

    def test_cli_checker_selection(self):
        for provider in ('claude', 'codex'):
            with self.subTest(provider=provider):
                executable = self.repo / provider
                executable.write_text(
                    '#!/usr/bin/env python3\n'
                    'import json, os, sys\n'
                    'from pathlib import Path\n'
                    'Path("cli-call.json").write_text(json.dumps(dict(argv=sys.argv, '
                    'stdin=sys.stdin.read(), internal=os.environ.get("KO_TONE_GUARD_INTERNAL"), '
                    'claudecode=os.environ.get("CLAUDECODE"))))\n'
                    'content=json.dumps({"issues":[{"phrase":"탄탄한 기반","reason":"자평"}]})\n'
                    f'provider={provider!r}\n'
                    'print(json.dumps({"result":content} if provider=="claude" else '
                    '{"type":"item.completed","item":{"type":"agent_message","text":content}}))\n'
                )
                executable.chmod(0o755)
                env = dict(KO_TONE_GUARD_MODEL=f'{provider}:selected',
                           PATH=f'{self.repo}:{os.environ["PATH"]}', CLAUDECODE='1')
                command = f'git commit -m "{provider}: 탄탄한 기반"'
                self.assertIn('탄탄한 기반', self.denied(self.hook(command, env_overrides=env)))
                call = json.loads((self.repo / 'cli-call.json').read_text())
                self.assertEqual(call['argv'][call['argv'].index('--model') + 1], 'selected')
                self.assertEqual(call['internal'], '1')
                if provider == 'claude':
                    self.assertIsNone(call['claudecode'])
                self.assertIn('탄탄한 기반', call['stdin'])
                self.assertEqual(self.hook(command, env_overrides=env), {})

    def test_checker_failure_preserves_regex(self):
        executable = self.repo / 'claude'
        executable.write_text('#!/bin/sh\nexit 1\n')
        executable.chmod(0o755)
        env = dict(KO_TONE_GUARD_MODEL='claude:sonnet', PATH=f'{self.repo}:{os.environ["PATH"]}')
        self.assertIn('획기적', self.denied(self.hook('git commit -m "획기적"', env_overrides=env)))
        self.assertIn('claude 응답 실패', self.hook('git commit -m "캐시 수정"', env_overrides=env)['systemMessage'])

    def test_internal_checker_skips_hook(self):
        self.assertEqual(self.hook('git commit -m "획기적"', env_overrides=dict(KO_TONE_GUARD_INTERNAL='1')), {})

    def test_server_url_precedence(self):
        executable = self.repo / 'curl'
        executable.write_text('#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\n'
                              'Path("curl-argv.json").write_text(json.dumps(sys.argv))\n'
                              'sys.stdin.read()\nprint(json.dumps({"message":{"content":"{\\"issues\\":[]}"}}))\n')
        executable.chmod(0o755)
        for new, old, expected in [
            (' http://new:8080/ ', 'http://old:8080', 'http://new:8080/api/chat'),
            (' ', 'http://old:8080/', 'http://old:8080/api/chat'),
            ('', '', 'http://localhost:11434/api/chat'),
        ]:
            env = dict(KO_TONE_GUARD_MODEL='ollama:test', KO_TONE_GUARD_BASE_URL=new,
                       KO_TONE_GUARD_OLLAMA_URL=old, PATH=f'{self.repo}:{os.environ["PATH"]}')
            self.assertEqual(self.hook('git commit -m "캐시 수정"', env_overrides=env), {})
            self.assertIn(expected, json.loads((self.repo / 'curl-argv.json').read_text()))

    def test_other_event_and_tool(self):
        self.assertEqual(self.hook('git commit -m "획기적"', hook_event_name='PostToolUse'), {})
        self.assertEqual(self.hook('git commit -m "획기적"', tool_name='apply_patch'), {})

    def test_errors_fail_open(self):
        result = subprocess.run(['bun', 'run', str(HOOK)], input='{', text=True,
                                capture_output=True, check=True)
        self.assertIn('검사 중 오류', json.loads(result.stdout)['systemMessage'])


if __name__ == '__main__':
    unittest.main()
