import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm, cp, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  deploymentConfig,
  validateOriginTls,
  writeDeploymentFiles,
} from './config.mjs';
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
    TLS_CERT: 'test-certificate',
    TLS_KEY: 'test-private-key',
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
  validateDispatch({ ...env, TLS_CERT: '', TLS_KEY: '' });
});

test('validates gateway ports and a hostname safe for an Nginx configuration', () => {
  const result = config();
  assert.equal(result.deployment.DAYLINE_HTTP_PORT, '80');
  assert.equal(result.deployment.DAYLINE_HTTPS_PORT, '443');
  assert.equal(result.deployment.DAYLINE_PROXY_NETWORK, 'dayline-proxy');
  assert.equal(result.deployment.NGINX_MODE, 'host');
  assert.equal(
    config({ NGINX_MODE: 'container' }).deployment.NGINX_MODE,
    'container',
  );
  for (const overrides of [
    { NGINX_HTTP_PORT: '443' },
    { NGINX_HTTPS_PORT: '13000' },
    { NGINX_HTTPS_PORT: '443;evil' },
    { NGINX_BIND_ADDRESS: 'untrusted-value' },
    { NGINX_MODE: 'unknown' },
  ])
    assert.throws(() => config(overrides));
  assert.throws(() => config({}, 'https://bad$(value).example'), /SITE_URL/);
});

let tlsDirectory;
let cert;
let key;
before(async () => {
  tlsDirectory = await mkdtemp(join(tmpdir(), 'dayline-tls-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=dayline.example.com',
      '-addext',
      'subjectAltName=DNS:dayline.example.com',
      '-keyout',
      join(tlsDirectory, 'key.pem'),
      '-out',
      join(tlsDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  cert = await readFile(join(tlsDirectory, 'cert.pem'), 'utf8');
  key = await readFile(join(tlsDirectory, 'key.pem'), 'utf8');
});
after(async () => {
  await rm(tlsDirectory, { recursive: true, force: true });
});
test('accepts a matching currently valid certificate covering the site hostname', () => {
  validateOriginTls(cert, key, 'dayline.example.com');
});
test('rejects mismatched or invalid PEM keys without returning private values', () => {
  const otherKey = generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  assert.throws(
    () => validateOriginTls(cert, otherKey, 'dayline.example.com'),
    /do not match/,
  );
  assert.throws(
    () =>
      validateOriginTls(cert, 'private-invalid-value', 'dayline.example.com'),
    (error) =>
      !error.message.includes('private-invalid-value') &&
      /TLS_KEY/.test(error.message),
  );
});
test('rejects expired and wrong-hostname certificates before deployment', () => {
  assert.throws(
    () => validateOriginTls(cert, key, 'other.example.com'),
    /hostname/,
  );
  assert.throws(
    () =>
      validateOriginTls(
        cert,
        key,
        'dayline.example.com',
        Date.now() + 3 * 86400000,
      ),
    /expiry/,
  );
  assert.throws(
    () =>
      validateOriginTls(
        cert,
        key,
        'dayline.example.com',
        Date.now() - 3 * 86400000,
      ),
    /start/,
  );
});

test('host mode renders an example without reading or storing TLS credentials', async () => {
  const input = join(tlsDirectory, 'host-input');
  const output = join(tlsDirectory, 'host-output');
  await cp(
    new URL('../../infra/nginx', import.meta.url),
    join(input, 'infra/nginx'),
    { recursive: true },
  );
  await writeDeploymentFiles(config(), input, output);
  const example = await readFile(
    join(output, 'nginx/host.conf.example'),
    'utf8',
  );
  assert.match(example, /proxy_pass http:\/\/127\.0\.0\.1:13000;/);
  assert.match(example, /dayline\.example\.com/);
  assert.equal((await stat(join(output, '.runtime.env'))).mode & 0o777, 0o600);
  await assert.rejects(access(join(output, 'tls')));
  await assert.rejects(access(join(output, 'nginx/default.conf')));
  assert.match(
    await readFile(join(output, '.deploy.env'), 'utf8'),
    /^NGINX_MODE=host$/m,
  );
});

test('container mode still requires a certificate before publishing runtime files', async () => {
  const input = join(tlsDirectory, 'container-input');
  const output = join(tlsDirectory, 'container-output');
  await cp(
    new URL('../../infra/nginx', import.meta.url),
    join(input, 'infra/nginx'),
    { recursive: true },
  );
  await assert.rejects(
    writeDeploymentFiles(config({ NGINX_MODE: 'container' }), input, output),
    /TLS_CERT and TLS_KEY/,
  );
  await assert.rejects(access(join(output, '.runtime.env')));
});
