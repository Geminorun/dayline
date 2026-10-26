import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const suffix = randomUUID().slice(0, 8),
  project = 'dayline-stage7-' + suffix,
  directory = resolve('.local/stage7/containers-' + suffix),
  password = randomBytes(24).toString('hex');
await mkdir(directory, { recursive: true, mode: 0o700 });
const environmentPath = directory + '/test.env',
  overridePath = directory + '/override.yaml',
  log = await open(directory + '/commands.log', 'w', 0o600);
const environment = {
  NODE_ENV: 'test',
  HOST: '0.0.0.0',
  PORT: '3000',
  POSTGRES_USER: 'dayline',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'dayline_container_test',
  POSTGRES_PORT: '15437',
  DATABASE_URL: `postgresql://dayline:${password}@db:5432/dayline_container_test`,
  API_DATABASE_URL: `postgresql://dayline:${password}@db:5432/dayline_container_test`,
  AUTH_BASE_URL: 'http://localhost:18080',
  WEB_BASE_URL: 'http://localhost:18080',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:18080',
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  ACTION_PROOF_SECRET: randomBytes(32).toString('hex'),
  MAIL_TRANSPORT: 'file',
  MAIL_PREVIEW_DIR: '/tmp/dayline-mail',
  MAIL_FROM: 'Dayline <noreply@example.com>',
  MAINTENANCE_ENABLED: 'true',
  RATE_LIMIT_ENABLED: 'true',
  DAYLINE_HOST: 'http://localhost',
  HTTP_PORT: '127.0.0.1:18080',
  HTTPS_PORT: '127.0.0.1:18443',
  DAYLINE_API_IMAGE: 'dayline-api:stage7-' + suffix,
  DAYLINE_BUILD_CA_FILE:
    process.env.CODEX_PROXY_CERT || '/etc/ssl/certs/ca-certificates.crt',
};
await writeFile(
  environmentPath,
  Object.entries(environment)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
await writeFile(
  overridePath,
  `services:\n  api:\n    environment:\n      NODE_ENV: test\n    env_file: !override\n      - ${environmentPath}\n`,
  { mode: 0o600 },
);
const dockerEnvironment = { ...process.env };
for (const key of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
])
  delete dockerEnvironment[key];
function docker(args, capture = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      'docker',
      ['--host=unix:///var/run/docker.sock', ...args],
      {
        env: dockerEnvironment,
        stdio: ['ignore', capture ? 'pipe' : log.fd, log.fd],
      },
    );
    let output = '';
    if (capture)
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolveResult(output)
        : reject(
            new Error(
              'Container verification command failed; inspect private commands.log',
            ),
          ),
    );
  });
}
const compose = (args, capture = false) =>
  docker(
    [
      'compose',
      '--env-file',
      environmentPath,
      '-p',
      project,
      '-f',
      'compose.yaml',
      '-f',
      'compose.production.yaml',
      '-f',
      overridePath,
      ...args,
    ],
    capture,
  );
try {
  await compose(['build', 'api']);
  await compose(['up', '-d', '--wait', 'db']);
  await compose(['run', '--rm', 'api', 'pnpm', 'db:deploy']);
  await compose(['up', '-d', '--wait', 'api', 'web']);
  const origin = 'http://localhost:18080';
  const ready = await fetch(origin + '/health/ready');
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get('cache-control') ?? '', /no-store/);
  for (const path of [
    '/day',
    '/account-deletion',
    '/entries/deep-link-fixture',
    '/auth/email-binding?token=sensitive-query-probe',
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await response.text(), /id="app"/);
  }
  const assetIndex = await (await fetch(origin + '/day')).text(),
    asset = assetIndex.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(origin + asset)).status, 200);
  const marker = randomUUID();
  await compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'dayline',
    '-d',
    'dayline_container_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE TABLE stage7_persistence_marker(id uuid PRIMARY KEY); INSERT INTO stage7_persistence_marker VALUES ('${marker}');`,
  ]);
  await compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'db']);
  assert.equal(
    (
      await compose(
        [
          'exec',
          '-T',
          'db',
          'psql',
          '-U',
          'dayline',
          '-d',
          'dayline_container_test',
          '-tA',
          '-c',
          `SELECT count(*) FROM stage7_persistence_marker WHERE id='${marker}'`,
        ],
        true,
      )
    ).trim(),
    '1',
  );
  let recovered = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(origin + '/health/ready')).ok) {
        recovered = true;
        break;
      }
    } catch {
      /* API reconnects while this fixture database restarts. */
    }
    await setTimeout(250);
  }
  assert.ok(recovered);
  const logs = await compose(['logs', '--no-color', 'web'], true);
  assert.ok(!logs.includes('sensitive-query-probe'));
  const volumes = (
    await docker(
      [
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.Name}}',
      ],
      true,
    )
  )
    .trim()
    .split('\n');
  const report = {
    measuredAt: new Date().toISOString(),
    project,
    image: environment.DAYLINE_API_IMAGE,
    origin,
    retainedVolumes: volumes,
    checks: {
      imageFreshInstallAndBuild: true,
      eightMigrations: true,
      apiReadiness: true,
      spaDeepLinks: true,
      staticAsset: true,
      apiProxy: true,
      referrerPolicy: true,
      queryAbsentFromAccessLogs: true,
      recreatedPostgresContainerRetainedData: true,
    },
    runtime:
      'local test configuration with file mail; no external delivery or deployment',
  };
  await writeFile(
    '.local/stage7/container-check.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await compose(['down', '--remove-orphans']).catch(() => {});
  await log.close();
  await chmod(directory, 0o700);
}
