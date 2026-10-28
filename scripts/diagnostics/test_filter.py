import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('diagnostic_filter', Path(__file__).with_name('filter.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FilterTests(unittest.TestCase):
    def test_only_support_fields_survive(self):
        source = '2026-10-28T03:00:00.000Z ERROR 7 [MailService] requestId=12345678-1234-1234-1234-123456789abc ' + json.dumps({
            'code': 'MAIL_DELIVERY_FAILED', 'providerCode': 'validation_error', 'providerStatus': 422,
            'email': 'private@example.com', 'password': 'secret', 'message': 'SQL private token',
            'html': 'https://private/verify?token=secret', 'details': {'apiKey': 'private'},
        })
        result = list(module.filter_lines([source]))
        self.assertEqual(result[0]['providerStatus'], 422)
        self.assertEqual(result[0]['requestId'], '12345678-1234-1234-1234-123456789abc')
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('secret', json.dumps(result))

    def test_raw_logs_and_credentials_are_never_forwarded(self):
        self.assertEqual(list(module.filter_lines(['password=secret', 'token=private', '{"email":"private@example.com"}'])), [])

    def test_docker_timestamp_and_safe_frames(self):
        result = list(module.filter_lines([
            '2026-10-28T03:00:00.123456789Z 2026-10-28T03:00:00.000Z ERROR 7 [EmailVerificationFlow] {"code":"EMAIL_FLOW_FAILED","mailStatus":"failed"}',
            'Error: private message', '    at Sender.send (/app/apps/api/dist/mail/mail.service.js:70:9)',
            '    at https://private.example/secret?token=private:1:2',
        ]))
        self.assertEqual(result[0]['frames'], ['at Sender.send (mail/mail.service.js:70:9)'])
        self.assertNotIn('private', json.dumps(result))

    def test_unknown_enums_and_query_urls_are_dropped(self):
        event = module.public_event('2026-10-28T03:00:00.000Z INFO 7 [HTTP] {"code":"HTTP_REQUEST","route":"/api/auth/verify-email?token=private","providerCode":"private-value"}')
        self.assertNotIn('route', event)
        self.assertNotIn('providerCode', event)


if __name__ == '__main__':
    unittest.main()
