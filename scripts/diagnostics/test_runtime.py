import json
from pathlib import Path
import shutil
import subprocess
import unittest


SCRIPT = Path(__file__).with_name('read.sh').read_text().split("node -e '", 1)[1].split("\n' 2>/dev/null", 1)[0]


def inspect_runtime(sender, **extra):
    return json.loads(subprocess.check_output([shutil.which('node') or 'node', '-e', SCRIPT], env={'MAIL_FROM': sender, **extra}, text=True))


class RuntimeTests(unittest.TestCase):
    def test_missing_at_or_unbalanced_brackets_are_invalid(self):
        for sender in ('notify.example.com', 'notify@example.com>', 'Dayline <notify@example.com', 'notify@-example.com'):
            with self.subTest(sender=sender):
                result = inspect_runtime(sender)
                self.assertFalse(result['mailFromValid'])
                self.assertIsNone(result['mailFromDomain'])

    def test_valid_addresses_expose_only_the_domain(self):
        for sender in ('private@example.com', '日序 <private@example.com>'):
            with self.subTest(sender=sender):
                result = inspect_runtime(sender)
                self.assertTrue(result['mailFromValid'])
                self.assertEqual(result['mailFromDomain'], 'example.com')
                self.assertNotIn('private', json.dumps(result))

    def test_runtime_configuration_is_projected_without_secrets(self):
        result = inspect_runtime('notify@example.com', RESEND_API_KEY='test-secret', DATABASE_URL='private-url', MAIL_TRANSPORT='resend', RELEASE_REVISION='a' * 40)
        self.assertTrue(result['resendKeyConfigured'])
        self.assertEqual(len(result['resendKeyFingerprint']), 12)
        self.assertEqual(result['revision'], 'a' * 40)
        self.assertEqual(result['mailTransport'], 'resend')
        self.assertNotIn('test-secret', json.dumps(result))
        self.assertNotIn('private-url', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
