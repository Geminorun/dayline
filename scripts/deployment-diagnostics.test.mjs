import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactDiagnostics } from './deployment-diagnostics.mjs';

test('redacts literal and URL-encoded credentials while preserving the failure', () => {
  const password = 'private $#:/value';
  const text = `connection failed: ${password}, postgresql://user:${encodeURIComponent(password)}@db`;
  const output = redactDiagnostics(text, [password, '', password]);
  assert.ok(!output.includes(password));
  assert.ok(!output.includes(encodeURIComponent(password)));
  assert.match(output, /connection failed/);
});

test('redacts complete PEM blocks before truncating diagnostic output', () => {
  const output = redactDiagnostics(
    'nginx failed\n-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----\nend',
    [],
  );
  assert.equal(output, 'nginx failed\n[redacted PEM]\nend');
});
