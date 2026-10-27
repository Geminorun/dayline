import process from 'node:process';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateDispatch(env) {
  for (const key of [
    'SITE_URL',
    'DEPLOY_HOST',
    'DEPLOY_USER',
    'DEPLOY_SSH_KEY',
    'DEPLOY_KNOWN_HOSTS',
    'APP_ENV',
    'DAYLINE_IMAGE',
    'RELEASE_REVISION',
    'REGISTRY_USER',
    'REGISTRY_TOKEN',
  ]) {
    if (!env[key]?.trim())
      throw new Error(`Missing deployment configuration: ${key}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(env.DEPLOY_HOST))
    throw new Error('Invalid DEPLOY_HOST.');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(env.DEPLOY_USER))
    throw new Error('Invalid DEPLOY_USER.');
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(env.DAYLINE_IMAGE))
    throw new Error('Expected a GHCR image digest.');
  if (!/^[a-f0-9]{40}$/.test(env.RELEASE_REVISION))
    throw new Error('Invalid RELEASE_REVISION.');
  let url;
  try {
    url = new URL(env.SITE_URL);
  } catch {
    throw new Error('Invalid SITE_URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.origin !== env.SITE_URL
  )
    throw new Error('SITE_URL must be an exact HTTPS origin.');
}

async function dispatch() {
  validateDispatch(process.env);
  const directory = await mkdtemp(join(tmpdir(), 'dayline-deploy-'));
  let remoteDirectory;
  const target = `${process.env.DEPLOY_USER}@${process.env.DEPLOY_HOST}`;
  const key = join(directory, 'ssh-key');
  const knownHosts = join(directory, 'known-hosts');
  const ssh = [
    '-i',
    key,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=6',
    '-o',
    'LogLevel=ERROR',
    target,
  ];
  function command(binary, args, inputFile, capture = false) {
    return new Promise((resolveCommand, reject) => {
      const child = spawn(binary, args, {
        stdio: [
          inputFile ? 'pipe' : 'ignore',
          capture ? 'pipe' : 'inherit',
          'inherit',
        ],
      });
      let output = '';
      if (capture)
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
      if (inputFile) {
        const input = createReadStream(inputFile);
        input.on('error', (error) => {
          child.kill();
          reject(error);
        });
        child.stdin.on('error', () => {
          input.destroy();
        });
        input.pipe(child.stdin);
      }
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolveCommand(output.trim())
          : reject(new Error(`${binary} failed; deployment stopped.`)),
      );
    });
  }
  try {
    await writeFile(key, process.env.DEPLOY_SSH_KEY.replace(/\r/g, '') + '\n', {
      mode: 0o600,
    });
    await writeFile(knownHosts, process.env.DEPLOY_KNOWN_HOSTS + '\n', {
      mode: 0o600,
    });
    const payload = join(directory, 'payload');
    await command('mkdir', ['-m', '700', payload]);
    for (const [file, keyName] of Object.entries({
      'app.env': 'APP_ENV',
      'site.url': 'SITE_URL',
      'image.ref': 'DAYLINE_IMAGE',
      revision: 'RELEASE_REVISION',
      'registry.user': 'REGISTRY_USER',
      'registry.token': 'REGISTRY_TOKEN',
    }))
      await writeFile(
        join(payload, file),
        (process.env[keyName] ?? '') + '\n',
        {
          mode: 0o600,
        },
      );
    const archive = join(directory, 'bundle.tgz');
    await command('tar', [
      '-czf',
      archive,
      '-C',
      resolve('.'),
      'compose.production.yaml',
      'scripts/deploy',
      'infra/nginx',
      '-C',
      payload,
      '.',
    ]);
    await chmod(archive, 0o600);
    remoteDirectory = await command(
      'ssh',
      [...ssh, 'umask 077; mktemp -d "$HOME/.dayline-incoming.XXXXXXXX"'],
      undefined,
      true,
    );
    if (
      !/^\/[a-zA-Z0-9_./-]+\/\.dayline-incoming\.[a-zA-Z0-9]+$/.test(
        remoteDirectory,
      )
    )
      throw new Error('Unexpected remote deployment directory.');
    // The only interpolated value is a strictly validated mktemp path, never a secret.
    await command(
      'ssh',
      [
        ...ssh,
        `umask 077; tar -xzf - -C '${remoteDirectory}' && bash '${remoteDirectory}/scripts/deploy/remote.sh' '${remoteDirectory}'`,
      ],
      archive,
    );
  } finally {
    if (
      remoteDirectory &&
      /^\/[a-zA-Z0-9_./-]+\/\.dayline-incoming\.[a-zA-Z0-9]+$/.test(
        remoteDirectory,
      )
    ) {
      await command('ssh', [...ssh, `rm -rf -- '${remoteDirectory}'`]).catch(
        () => {
          console.error(
            'Remote temporary cleanup failed; remove the incoming directory through the server console.',
          );
        },
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await dispatch();
  } catch (error) {
    // Do not forward arbitrary SSH/key/parser exception text containing configuration values.
    console.error(
      error instanceof Error &&
        /^(Missing deployment configuration:|Invalid |Expected |SITE_URL|Unexpected remote|ssh failed|tar failed)/.test(
          error.message,
        )
        ? error.message
        : 'Deployment failed; inspect the preceding operation status and private server release logs.',
    );
    process.exitCode = 1;
  }
}
