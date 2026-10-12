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

    def hook(self, command, session='test', **fields):
        event = dict(hook_event_name='PreToolUse', tool_name='Bash', cwd=str(self.repo),
                     session_id=session, tool_input=dict(command=command))
        event.update(fields)
        env = dict(os.environ, KO_TONE_GUARD_OLLAMA_MODEL='', PLUGIN_DATA=str(self.repo / 'data'))
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

    def test_workdir(self):
        (self.repo / 'a.ts').write_text('// 획기적인 캐시\n')
        self.git('add', 'a.ts')
        self.denied(self.hook('', cwd='/tmp', tool_input=dict(command='git commit -m "캐시 수정"', workdir=str(self.repo))))

    def test_unresolved_path(self):
        self.assertIn('셸 변수', self.denied(self.hook('git -C "$DIR" commit -m "수정"')))

    def test_bypass(self):
        self.assertEqual(self.hook('KO_TONE_GUARD=off git commit -m "획기적"'), {})

    def test_other_event_and_tool(self):
        self.assertEqual(self.hook('git commit -m "획기적"', hook_event_name='PostToolUse'), {})
        self.assertEqual(self.hook('git commit -m "획기적"', tool_name='apply_patch'), {})

    def test_errors_fail_open(self):
        result = subprocess.run(['bun', 'run', str(HOOK)], input='{', text=True,
                                capture_output=True, check=True)
        self.assertIn('검사 중 오류', json.loads(result.stdout)['systemMessage'])


if __name__ == '__main__':
    unittest.main()
