import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  writeFile,
  readFile,
  open,
  cp,
  readlink,
  stat,
  readdir,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  createServer as createTlsServer,
  request as httpsRequest,
} from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const suffix = randomUUID().slice(0, 8);
const project = `dayline-deploy-${suffix}`;
const container = `${project}-postgres`;
const volume = `${project}-postgres-data`;
const image = process.env.DAYLINE_TEST_IMAGE || `dayline:deploy-${suffix}`;
const directory = resolve('.local/deployment', suffix);
const bundle = join(directory, 'bundle');
const serverDirectory = join(directory, 'server');
await mkdir(bundle, { recursive: true, mode: 0o700 });
const log = await open(join(directory, 'commands.log'), 'w', 0o600);
const environment = { ...process.env };
for (const key of [
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
])
  delete environment[key];
environment.DOCKER_HOST = 'unix:///var/run/docker.sock';
function command(binary, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, {
      env: { ...environment, ...options.env },
      stdio: ['ignore', options.capture ? 'pipe' : log.fd, log.fd],
    });
    let output = '';
    if (options.capture)
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.allowFailure) resolveCommand({ code, output });
      else if (code === 0) resolveCommand(output.trim());
      else
        reject(
          new Error(
            `Deployment verification failed (${binary}); inspect private ${directory}/commands.log`,
          ),
        );
    });
  });
}
const docker = (args, options) =>
  command('docker', ['--host=unix:///var/run/docker.sock', ...args], options);
const sql = (text, database = 'postgres') =>
  docker(
    [
      'exec',
      container,
      'psql',
      '-XAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      database,
      '-c',
      text,
    ],
    { capture: true },
  );
const reservedPorts = new Set();
async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (reservedPorts.has(port)) return availablePort();
  reservedPorts.add(port);
  return port;
}
const appPort = await availablePort();
const httpPort = await availablePort();
const httpsPort = await availablePort();
const publicOrigin = `https://localhost:${httpsPort}`;
let stripRevision = false;
let tlsServer;
const password = randomBytes(24).toString('hex') + '$#@:/ \'double"value';
const database = `dayline_deploy_${suffix}_test`;
const role = `dayline_${suffix}`;
const fields = {
  POSTGRES_CONTAINER: container,
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: database,
  POSTGRES_USER: role,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  ACTION_PROOF_SECRET: randomBytes(32).toString('hex'),
  RESEND_API_KEY: 'deployment-verification-no-mail',
  MAIL_FROM: 'Dayline <noreply@example.com>',
  APP_PORT: String(appPort),
  NGINX_HTTP_PORT: String(httpPort),
  NGINX_HTTPS_PORT: String(httpsPort),
  NGINX_BIND_ADDRESS: '127.0.0.1',
  DEPLOY_PROJECT: project,
};
async function writeEnvironment(overrides = {}) {
  await writeFile(
    join(bundle, 'app.env'),
    Object.entries({ ...fields, ...overrides })
      .map(([key, value]) => `${key}=\`${value}\``)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
const revision = (label) =>
  createHash('sha1').update(`${suffix}:${label}`).digest('hex');
async function deploy(label, allowFailure = false) {
  await writeFile(join(bundle, 'revision'), revision(label), { mode: 0o600 });
  return command('bash', [join(bundle, 'scripts/deploy/apply.sh'), bundle], {
    allowFailure,
    env: {
      DAYLINE_DEPLOY_ROOT: serverDirectory,
      CURL_CA_BUNDLE: join(directory, 'tls.crt'),
    },
  });
}
async function tlsFetch(url, headers = {}, body) {
  const ca = await readFile(join(directory, 'tls.crt'));
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(
      url,
      { ca, headers, method: body ? 'POST' : 'GET' },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolveResponse({
            status: response.statusCode,
            headers: new globalThis.Headers(response.headers),
            text: async () => body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function publicCheck(expectedRevision) {
  const origin = publicOrigin;
  const redirect = await fetch(
    `http://127.0.0.1:${httpPort}/day?test=redirect`,
    { redirect: 'manual' },
  );
  assert.equal(redirect.status, 308);
  assert.equal(
    redirect.headers.get('location'),
    publicOrigin + '/day?test=redirect',
  );
  for (const path of [
    '/day',
    '/entries/example',
    '/account-deletion',
    '/auth/email-binding?token=private-query',
  ]) {
    const response = await tlsFetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-dayline-revision'), expectedRevision);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.match(await response.text(), /id="app"/);
  }
  const html = await (await tlsFetch(origin + '/day')).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const response = await tlsFetch(origin + asset);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /immutable/);
  assert.equal((await tlsFetch(origin + '/api/v1/snapshot')).status, 401);
  for (const path of [
    '/assets/missing.js',
    '/.env',
    '/api/v1/missing',
    '/health/missing',
  ])
    assert.equal((await tlsFetch(origin + path)).status, 404);
}
let postgresStarted = false;
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  if (!process.env.DAYLINE_TEST_IMAGE) {
    const args = ['build'];
    if (process.env.CODEX_PROXY_CERT)
      args.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
    args.push('-t', image, '.');
    await docker(args);
  }
  await docker(['volume', 'create', volume]);
  await docker([
    'run',
    '-d',
    '--name',
    container,
    '--mount',
    `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
    '-e',
    `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
    'postgres:17-alpine',
  ]);
  postgresStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await docker(
      ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { allowFailure: true },
    );
    if (result.code === 0) {
      ready = true;
      break;
    }
    await setTimeout(500);
  }
  assert.ok(ready);
  await sql(
    'CREATE TABLE public.unrelated_marker(value integer); INSERT INTO public.unrelated_marker VALUES (17)',
  );
  await cp('compose.production.yaml', join(bundle, 'compose.production.yaml'));
  await cp('scripts/deploy', join(bundle, 'scripts/deploy'), {
    recursive: true,
  });
  await cp('infra/nginx', join(bundle, 'infra/nginx'), { recursive: true });
  await writeFile(join(bundle, 'image.ref'), image, { mode: 0o600 });
  await writeEnvironment();
  await command('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    join(directory, 'tls.key'),
    '-out',
    join(directory, 'tls.crt'),
  ]);
  await cp(join(directory, 'tls.crt'), join(bundle, 'tls.crt'));
  await cp(join(directory, 'tls.key'), join(bundle, 'tls.key'));
  tlsServer = createTlsServer(
    {
      key: await readFile(join(directory, 'tls.key')),
      cert: await readFile(join(directory, 'tls.crt')),
    },
    (request, response) => {
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: appPort,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (result) => {
          const headers = { ...result.headers };
          if (stripRevision) delete headers['x-dayline-revision'];
          response.writeHead(result.statusCode || 502, headers);
          result.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  await new Promise((resolveListen) =>
    tlsServer.listen(0, '127.0.0.1', resolveListen),
  );
  const address = tlsServer.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(join(bundle, 'site.url'), publicOrigin, { mode: 0o600 });
  await deploy('first');
  await publicCheck(revision('first'));
  // A fixed nonexistent identity with changing forged IP headers must still
  // hit the real peer's failure limit. Sign-in never sends provider email.
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await tlsFetch(
      publicOrigin + '/api/auth/sign-in/email',
      {
        'Content-Type': 'application/json',
        Origin: publicOrigin,
        'CF-Connecting-IP': `192.0.2.${attempt + 1}`,
        'X-Forwarded-For': `198.51.100.${attempt + 1}`,
      },
      JSON.stringify({
        email: `gateway-${suffix}@example.com`,
        password: 'not-a-real-account-password',
      }),
    );
    assert.equal(response.status, attempt < 5 ? 401 : 429);
  }
  assert.equal(
    await sql(
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      database,
    ),
    '8',
  );
  assert.equal(
    await sql(
      `SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) FROM pg_roles WHERE rolname='${role}'`,
    ),
    't',
  );
  await sql(
    'CREATE TABLE public.deployment_marker(value integer); INSERT INTO public.deployment_marker VALUES (42)',
    database,
  );
  await deploy('second');
  await publicCheck(revision('second'));
  assert.equal(
    await sql('SELECT value FROM public.deployment_marker', database),
    '42',
  );
  assert.equal(await sql('SELECT value FROM public.unrelated_marker'), '17');
  await writeFile(join(bundle, 'tls.key'), 'invalid-private-value', {
    mode: 0o600,
  });
  const invalidTls = await deploy('invalid-tls', true);
  assert.notEqual(invalidTls.code, 0);
  await publicCheck(revision('second'));
  await cp(join(directory, 'tls.key'), join(bundle, 'tls.key'));
  await writeEnvironment({ POSTGRES_PASSWORD: 'incorrect-password' });
  const wrongPassword = await deploy('wrong-password', true);
  assert.notEqual(wrongPassword.code, 0);
  await publicCheck(revision('second'));
  assert.equal(
    await readFile(join(serverDirectory, 'deployed-revision'), 'utf8'),
    revision('second') + '\n',
  );
  await writeEnvironment();
  stripRevision = true;
  await writeFile(
    join(bundle, 'site.url'),
    `https://localhost:${address.port}`,
    { mode: 0o600 },
  );
  const wrongPublicEndpoint = await deploy('wrong-public-endpoint', true);
  assert.notEqual(wrongPublicEndpoint.code, 0);
  assert.equal(
    await readFile(join(serverDirectory, 'deployed-revision'), 'utf8'),
    revision('second') + '\n',
  );
  assert.equal(
    await sql('SELECT value FROM public.deployment_marker', database),
    '42',
  );
  stripRevision = false;
  await writeFile(join(bundle, 'site.url'), publicOrigin, { mode: 0o600 });
  await deploy('recovered');
  await publicCheck(revision('recovered'));
  assert.equal(
    await sql('SELECT value FROM public.deployment_marker', database),
    '42',
  );
  const current = await readlink(join(serverDirectory, 'current'));
  assert.equal((await stat(join(current, '.runtime.env'))).mode & 0o777, 0o600);
  const backups = await readdir(join(serverDirectory, 'backups'));
  assert.equal(backups.length, 4);
  for (const backup of backups) {
    const info = await stat(join(serverDirectory, 'backups', backup));
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok(info.size > 0);
  }
  const report = {
    passed: true,
    postgres: 17,
    migrations: 8,
    singleContainerWebAndApi: true,
    nginxTlsGateway: true,
    forgedForwardingHeadersRejected: true,
    certificateAndKeyValidated: true,
    invalidCertificatePreservesRunningRelease: true,
    repeatedDeploymentPreservesData: true,
    wrongPasswordPreservesRunningRelease: true,
    stalePublicEndpointRejected: true,
    explicitRecoveryPreservesData: true,
    unrelatedDatabasePreserved: true,
    backups: backups.length,
    retainedVolume: volume,
  };
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  if (tlsServer)
    await new Promise((resolveClose) => tlsServer.close(resolveClose));
  try {
    const current = await readlink(join(serverDirectory, 'current'));
    await docker([
      'compose',
      '--project-name',
      project,
      '--env-file',
      join(current, '.deploy.env'),
      '-f',
      join(current, 'compose.production.yaml'),
      'down',
    ]);
  } catch {
    /* Keep private evidence when no deployment completed. */
  }
  if (postgresStarted) await docker(['rm', '-f', container]);
  await docker(['network', 'rm', `${project}-database`, `${project}-proxy`], {
    allowFailure: true,
  });
  await log.close();
}
