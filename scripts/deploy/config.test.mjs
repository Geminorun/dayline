import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentConfig } from './config.mjs';
import { validateDispatch } from './dispatch.mjs';

const password = 'special$#@:/ \'double"value';
const fields = {
  POSTGRES_CONTAINER: 'existing-pg17',
  POSTGRES_PASSWORD: password,
  BETTER_AUTH_SECRET: 'a'.repeat(64),
  ACTION_PROOF_SECRET: 'b'.repeat(64),
  RESEND_API_KEY: 'provider-test-key',
  MAIL_FROM: 'Dayline <noreply@example.com>',
};
function config(overrides = {}, origin = 'https://dayline.example.com') {
  const input = Object.entries({ ...fields, ...overrides })
    .map(([key, value]) => `${key}=\`${value}\``)
    .join('\n');
  return deploymentConfig(
    input,
    origin,
    'ghcr.io/example/dayline@sha256:' + 'a'.repeat(64),
    'b'.repeat(40),
    '172.22.0.1',
  );
}
test('derives same-origin production URLs, isolates admin credentials, and preserves a supplied special-character password', () => {
  const result = config({ POSTGRES_ADMIN_PASSWORD: 'admin-only-value' });
  const url = new URL(result.runtime.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.hostname, 'dayline-postgres');
  assert.equal(url.pathname, '/dayline');
  assert.equal(result.runtime.AUTH_BASE_URL, result.runtime.WEB_BASE_URL);
  assert.equal(
    result.runtime.AUTH_TRUSTED_ORIGINS,
    result.runtime.WEB_BASE_URL,
  );
  assert.equal(result.runtime.TRUST_PROXY, '172.22.0.1');
  assert.equal(result.database.DAYLINE_DATABASE_PASSWORD, password);
  assert.equal(result.database.PGPASSWORD, 'admin-only-value');
  assert.ok(!Object.values(result.runtime).includes('admin-only-value'));
  assert.equal(result.deployment.DAYLINE_APP_PORT, '13000');
});
test('requires an explicit container and password rather than inventing or rotating credentials', () => {
  assert.throws(() => config({ POSTGRES_PASSWORD: '' }), /POSTGRES_PASSWORD/);
  assert.throws(() => config({ POSTGRES_CONTAINER: '' }), /POSTGRES_CONTAINER/);
});
test('rejects shell/SQL identifiers, reserved databases, and administrator reuse', () => {
  for (const overrides of [
    { POSTGRES_DB: 'postgres' },
    { POSTGRES_DB: 'template1' },
    { POSTGRES_DB: 'dayline;DROP DATABASE x' },
    { POSTGRES_USER: 'postgres' },
    { POSTGRES_CONTAINER: '--privileged' },
    { DEPLOY_PROJECT: 'dayline;touch /tmp/x' },
    { APP_PORT: '80' },
  ])
    assert.throws(() => config(overrides));
});
test('rejects unknown fields, multiline secrets, shared authentication secrets, and partial WeChat setup', () => {
  assert.throws(
    () => config({ DATABASE_URL: 'not-allowed' }),
    /Unknown APP_ENV field/,
  );
  assert.throws(
    () => config({ POSTGRES_PASSWORD: 'line1\nline2' }),
    /single line/,
  );
  assert.throws(
    () => config({ ACTION_PROOF_SECRET: fields.BETTER_AUTH_SECRET }),
    /independent/,
  );
  assert.throws(() => config({ WECHAT_APP_ID: 'wx-example' }), /together/);
  assert.throws(
    () =>
      config({
        WECHAT_APP_ID: 'wx-example',
        WECHAT_APP_SECRET: 'wx-key',
        WECHAT_MINIAPP_ENV: 'unknown',
      }),
    /WECHAT_MINIAPP_ENV/,
  );
});
test('requires exact HTTPS origins and reports field names without private values', () => {
  for (const origin of [
    'http://example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://user:private@example.com',
    'invalid',
  ])
    assert.throws(() => config({}, origin), /SITE_URL/);
  try {
    config({ POSTGRES_DB: 'private-invalid-value' });
  } catch (error) {
    assert.ok(!error.message.includes('private-invalid-value'));
  }
});
test('dispatch rejects option injection and unpinned images before starting SSH', () => {
  const env = {
    SITE_URL: 'https://dayline.example.com',
    DEPLOY_HOST: '192.0.2.1',
    DEPLOY_USER: 'ubuntu',
    DEPLOY_SSH_KEY: 'test-key',
    DEPLOY_KNOWN_HOSTS: 'test-host',
    APP_ENV: 'test',
    DAYLINE_IMAGE: 'ghcr.io/example/dayline@sha256:' + 'a'.repeat(64),
    RELEASE_REVISION: 'b'.repeat(40),
    REGISTRY_USER: 'example',
    REGISTRY_TOKEN: 'test-token',
  };
  validateDispatch(env);
  for (const override of [
    { DEPLOY_HOST: '-oProxyCommand=bad' },
    { DEPLOY_USER: 'user;bad' },
    { DAYLINE_IMAGE: 'ghcr.io/example/dayline:latest' },
    { DEPLOY_KNOWN_HOSTS: '' },
    { SITE_URL: 'http://example.com' },
  ])
    assert.throws(() => validateDispatch({ ...env, ...override }));
});
