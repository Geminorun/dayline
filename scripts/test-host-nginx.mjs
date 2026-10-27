// Test fixture only: run real Nginx as an independent host process, without
// installing services, using Docker host networking, or changing /etc/nginx.
import process from 'node:process';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function startTestHostNginx({
  directory,
  bundle,
  appPort,
  httpPort,
  httpsPort,
  publicOrigin,
  project,
  docker,
  command,
  log,
}) {
  let binary = process.env.DAYLINE_TEST_HOST_NGINX;
  if (!binary) {
    const tool = `${project}-nginx-tool`;
    await docker([
      'create',
      '--name',
      tool,
      'nginx:1.28.0@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609',
    ]);
    try {
      binary = join(directory, 'host-nginx');
      await docker(['cp', `${tool}:/usr/sbin/nginx`, binary]);
    } finally {
      await docker(['rm', tool]);
    }
  }
  const quote = (path) => '"' + path.replace(/[\\"$]/g, '\\$&') + '"';
  const site = (
    await readFile(join(bundle, 'infra/nginx/host.conf.template'), 'utf8')
  )
    .replaceAll('@SITE_HOST@', 'localhost')
    .replaceAll('@SITE_URL@', publicOrigin)
    .replaceAll('@APP_PORT@', String(appPort))
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`)
    .replace('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`)
    .replace('/etc/nginx/ssl/dayline/origin.crt', join(directory, 'tls.crt'))
    .replace('/etc/nginx/ssl/dayline/origin.key', join(directory, 'tls.key'))
    .replace(
      '/etc/nginx/snippets/dayline-cloudflare-real-ip.conf',
      join(bundle, 'infra/nginx/cloudflare-real-ip.conf'),
    );
  const configuration = join(directory, 'host-nginx.conf');
  const errorLog = join(directory, 'host-nginx-error.log');
  const pidFile = join(directory, 'host-nginx.pid');
  await writeFile(errorLog, '', { mode: 0o600 });
  await writeFile(
    configuration,
    `pid ${quote(pidFile)};\nevents { worker_connections 128; }\nhttp {\naccess_log off;\n` +
      [
        'client_body_temp_path',
        'proxy_temp_path',
        'fastcgi_temp_path',
        'uwsgi_temp_path',
        'scgi_temp_path',
      ]
        .map((name) => `${name} ${quote(join(directory, name))};`)
        .join('\n') +
      '\n' +
      site +
      '\n}\n',
    { mode: 0o600 },
  );
  const args = ['-p', directory + '/', '-c', configuration, '-e', errorLog];
  const initialConfiguration = await readFile(configuration, 'utf8');
  await command(binary, [...args, '-t']);
  const child = spawn(binary, [...args, '-g', 'daemon off;'], {
    stdio: ['ignore', log.fd, log.fd],
  });
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  let initialPid;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError || child.exitCode !== null)
        throw new Error('The independent host Nginx fixture did not start.');
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/day`, {
          redirect: 'manual',
        });
        if (response.status === 308) {
          initialPid = await readFile(pidFile, 'utf8');
          break;
        }
      } catch {
        /* Wait for this fixture's listener. */
      }
      await setTimeout(100);
    }
    assert.ok(initialPid);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  return {
    async assertUnchanged() {
      assert.equal(
        child.exitCode,
        null,
        'Deployment stopped the independent host Nginx.',
      );
      assert.equal(await readFile(pidFile, 'utf8'), initialPid);
      assert.equal(await readFile(configuration, 'utf8'), initialConfiguration);
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise((resolveStopped) => {
        child.once('close', resolveStopped);
        child.kill('SIGTERM');
      });
    },
  };
}
