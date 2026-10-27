import process from 'node:process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { parse } = require('dotenv');
const allowed = new Set([
  'POSTGRES_CONTAINER',
  'POSTGRES_ADMIN_USER',
  'POSTGRES_ADMIN_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'BETTER_AUTH_SECRET',
  'ACTION_PROOF_SECRET',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
  'WECHAT_MINIAPP_ENV',
  'APP_PORT',
  'DEPLOY_PROJECT',
  'NGINX_HTTP_PORT',
  'NGINX_HTTPS_PORT',
  'NGINX_BIND_ADDRESS',
]);

export function deploymentConfig(text, siteUrl, image, revision, proxyIp = '') {
  const input = parse(text);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown APP_ENV field: ${key}`);
    if (/[\r\n\0]/.test(value))
      throw new Error(`APP_ENV field must be a single line: ${key}`);
  }
  function required(key) {
    if (!input[key]?.trim()) throw new Error(`Missing APP_ENV field: ${key}`);
    return input[key];
  }
  function identifier(key, fallback) {
    const value = input[key] || fallback;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
      throw new Error(`Invalid PostgreSQL identifier: ${key}`);
    return value;
  }
  let origin;
  try {
    const url = new URL(siteUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.origin !== siteUrl ||
      !/^[a-z0-9.-]+$/.test(url.hostname)
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new Error(
      'SITE_URL must be an exact HTTPS origin without a trailing slash.',
    );
  }
  if (!/^[a-z0-9][a-z0-9./:@_-]*$/.test(image))
    throw new Error('Invalid release image.');
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Invalid release revision.');
  const container = required('POSTGRES_CONTAINER');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))
    throw new Error('Invalid POSTGRES_CONTAINER.');
  const project = input.DEPLOY_PROJECT || 'dayline';
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(project))
    throw new Error('Invalid DEPLOY_PROJECT.');
  const port = input.APP_PORT || '13000';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('APP_PORT must be between 1024 and 65535.');
  const httpPort = input.NGINX_HTTP_PORT || '80';
  const httpsPort = input.NGINX_HTTPS_PORT || '443';
  for (const value of [httpPort, httpsPort]) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error('Nginx ports must be between 1 and 65535.');
  }
  if (new Set([Number(port), Number(httpPort), Number(httpsPort)]).size !== 3)
    throw new Error('Application and Nginx ports must be distinct.');
  const bindAddress = input.NGINX_BIND_ADDRESS || '0.0.0.0';
  if (!['0.0.0.0', '127.0.0.1'].includes(bindAddress))
    throw new Error('NGINX_BIND_ADDRESS must be 0.0.0.0 or 127.0.0.1.');
  if (proxyIp && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(proxyIp))
    throw new Error('Invalid Docker proxy gateway.');
  const db = identifier('POSTGRES_DB', 'dayline');
  const user = identifier('POSTGRES_USER', 'dayline');
  const admin = identifier('POSTGRES_ADMIN_USER', 'postgres');
  if (db === 'postgres' || db.startsWith('template') || user === admin)
    throw new Error(
      'Use a dedicated application database and a non-admin application role.',
    );
  const password = required('POSTGRES_PASSWORD');
  for (const key of ['BETTER_AUTH_SECRET', 'ACTION_PROOF_SECRET']) {
    if (
      required(key).length < 32 ||
      /local-development|replace|change-me/i.test(input[key])
    )
      throw new Error(
        `Use an independent generated secret of at least 32 characters: ${key}`,
      );
  }
  if (input.BETTER_AUTH_SECRET === input.ACTION_PROOF_SECRET)
    throw new Error('Application secrets must be independent.');
  required('RESEND_API_KEY');
  required('MAIL_FROM');
  if (Boolean(input.WECHAT_APP_ID) !== Boolean(input.WECHAT_APP_SECRET))
    throw new Error('Configure WECHAT_APP_ID and WECHAT_APP_SECRET together.');
  const wxEnvironment = input.WECHAT_MINIAPP_ENV || 'release';
  if (!['develop', 'trial', 'release'].includes(wxEnvironment))
    throw new Error('Invalid WECHAT_MINIAPP_ENV.');
  return {
    runtime: {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '3000',
      WEB_DIST_DIR: '/app/apps/web/dist',
      RELEASE_REVISION: revision,
      DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@dayline-postgres:5432/${db}`,
      AUTH_BASE_URL: origin,
      AUTH_TRUSTED_ORIGINS: origin,
      WEB_BASE_URL: origin,
      BETTER_AUTH_SECRET: input.BETTER_AUTH_SECRET,
      ACTION_PROOF_SECRET: input.ACTION_PROOF_SECRET,
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: input.RESEND_API_KEY,
      MAIL_FROM: input.MAIL_FROM,
      WECHAT_APP_ID: input.WECHAT_APP_ID || '',
      WECHAT_APP_SECRET: input.WECHAT_APP_SECRET || '',
      WECHAT_MINIAPP_ENV: wxEnvironment,
      WECHAT_MINIAPP_SCAN_PAGE: 'pages/scan/confirm',
      TRUST_PROXY: proxyIp,
      RATE_LIMIT_ENABLED: 'true',
      MAINTENANCE_ENABLED: 'true',
      LOG_LEVEL: 'info',
    },
    database: {
      PGUSER: admin,
      PGDATABASE: 'postgres',
      PGPASSWORD: input.POSTGRES_ADMIN_PASSWORD || '',
      DAYLINE_DATABASE_NAME: db,
      DAYLINE_DATABASE_USER: user,
      DAYLINE_DATABASE_PASSWORD: password,
    },
    deployment: {
      DAYLINE_IMAGE: image,
      DAYLINE_APP_PORT: port,
      DAYLINE_DB_NETWORK: `${project}-database`,
      DAYLINE_PROXY_NETWORK: `${project}-proxy`,
      DAYLINE_HTTP_PORT: httpPort,
      DAYLINE_HTTPS_PORT: httpsPort,
      DAYLINE_NGINX_BIND: bindAddress,
      DEPLOY_PROJECT: project,
      POSTGRES_CONTAINER: container,
      POSTGRES_DB: db,
      POSTGRES_USER: user,
      POSTGRES_ADMIN_USER: admin,
      SITE_URL: origin,
      RELEASE_REVISION: revision,
    },
  };
}

export function validateOriginTls(certPem, keyPem, hostname, now = Date.now()) {
  let certificate;
  let key;
  try {
    certificate = new X509Certificate(certPem);
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error(
      'TLS_CERT and TLS_KEY must contain a PEM certificate and an unencrypted private key.',
    );
  }
  if (!certificate.checkPrivateKey(key))
    throw new Error('TLS_CERT and TLS_KEY do not match.');
  const matches = isIP(hostname)
    ? certificate.checkIP(hostname)
    : certificate.checkHost(hostname);
  if (!matches)
    throw new Error('TLS_CERT does not cover the SITE_URL hostname.');
  if (
    now < Date.parse(certificate.validFrom) ||
    now >= Date.parse(certificate.validTo)
  )
    throw new Error(
      'TLS_CERT is not currently valid; check its start and expiry dates.',
    );
}

async function render() {
  const [, , inputFile, directory] = process.argv;
  if (!inputFile || !directory)
    throw new Error('Expected APP_ENV input and output directory.');
  const config = deploymentConfig(
    await readFile(inputFile, 'utf8'),
    process.env.SITE_URL,
    process.env.DAYLINE_IMAGE,
    process.env.RELEASE_REVISION,
    process.env.DAYLINE_PROXY_IP,
  );
  const { parseEnvironment } =
    await import('../../apps/api/dist/config/environment.js');
  parseEnvironment(config.runtime);
  const inputDirectory = dirname(inputFile);
  const cert = await readFile(join(inputDirectory, 'tls.crt'), 'utf8');
  const key = await readFile(join(inputDirectory, 'tls.key'), 'utf8');
  const hostname = new URL(config.runtime.WEB_BASE_URL).hostname;
  validateOriginTls(cert, key, hostname);
  const nginxTemplate = await readFile(
    join(inputDirectory, 'infra/nginx/default.conf.template'),
    'utf8',
  );
  const realIpConfig = await readFile(
    join(inputDirectory, 'infra/nginx/cloudflare-real-ip.conf'),
    'utf8',
  );
  await mkdir(join(directory, 'nginx'), { mode: 0o700 });
  await mkdir(join(directory, 'tls'), { mode: 0o700 });
  await writeFile(join(directory, 'tls/tls.crt'), cert, { mode: 0o600 });
  await writeFile(join(directory, 'tls/tls.key'), key, { mode: 0o600 });
  await writeFile(
    join(directory, 'nginx/default.conf'),
    nginxTemplate
      .replaceAll('@SITE_HOST@', hostname)
      .replaceAll('@SITE_URL@', config.runtime.WEB_BASE_URL),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'nginx/cloudflare-real-ip.conf'),
    realIpConfig,
    { mode: 0o600 },
  );
  for (const [name, values] of Object.entries({
    '.runtime.env': config.runtime,
    '.database.env': config.database,
    '.deploy.env': config.deployment,
  })) {
    // Docker env-file raw format: values are literal, including spaces, $, # and quotes.
    await writeFile(
      join(directory, name),
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await render();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Invalid deployment configuration.',
    );
    process.exitCode = 1;
  }
}
