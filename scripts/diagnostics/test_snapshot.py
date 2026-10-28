import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).with_name('snapshot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def test_success_contains_a_fresh_timestamp_and_sanitized_collector_output(self):
        output = b'{"kind":"diagnostics","version":1}\n{"code":"MAIL_ACCEPTED"}\n'
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=output)):
            result = module.build_snapshot()
        metadata, *records = [json.loads(line) for line in result.splitlines()]
        self.assertEqual(metadata['collectionStatus'], 'ok')
        self.assertRegex(metadata['generatedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(records, [json.loads(line) for line in output.splitlines()])

    def test_failure_never_publishes_partial_output_or_exception_text(self):
        errors = [
            subprocess.CalledProcessError(1, 'collector', output=b'private@example.com'),
            subprocess.TimeoutExpired('collector', 35, output=b'token=private'),
            FileNotFoundError('private error detail'),
        ]
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(module.subprocess, 'run', side_effect=error):
                result = module.build_snapshot()
                self.assertEqual(len(result.splitlines()), 1)
                self.assertEqual(json.loads(result)['collectionStatus'], 'failed')
                self.assertNotIn(b'private', result)

    def test_malformed_output_is_not_published(self):
        for output in (b'private error', b'{"kind":"diagnostics"}\nnot-json', b'{"kind":"unknown"}', b'[]', b''):
            with self.subTest(output=output), patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=output)):
                self.assertEqual(json.loads(module.build_snapshot())['collectionStatus'], 'failed')

    def test_atomic_replacement_preserves_read_only_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'summary.ndjson'
            target.write_bytes(b'old-complete-snapshot')
            real_replace = module.os.replace

            def replace(source, destination):
                self.assertEqual(target.read_bytes(), b'old-complete-snapshot')
                self.assertEqual(Path(source).read_bytes(), b'new-complete-snapshot')
                real_replace(source, destination)

            with patch.object(module.os, 'replace', side_effect=replace):
                module.publish_snapshot(directory, b'new-complete-snapshot', os.getgid())
            self.assertEqual(target.read_bytes(), b'new-complete-snapshot')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(Path(directory).iterdir()), [target])
