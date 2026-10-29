import { execFileSync } from 'node:child_process';
import process from 'node:process';

const commonFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.node-version',
  '.npmrc',
  '.gitattributes',
]);
const serverFiles = new Set([
  'Dockerfile',
  '.dockerignore',
  'compose.yaml',
  'compose.production.yaml',
]);

/** One scope is used for both routing CI and deciding whether a release is stale. */
export function serverScope(paths) {
  let affected = false;
  let shared = false;
  for (const path of paths) {
    if (commonFiles.has(path) || path.startsWith('packages/')) {
      affected = true;
      shared = true;
    } else if (
      serverFiles.has(path) ||
      path.startsWith('apps/api/') ||
      path.startsWith('apps/web/') ||
      path.startsWith('infra/') ||
      (path.startsWith('scripts/') && !path.startsWith('scripts/miniapp/')) ||
      [
        '.github/workflows/server.yml',
        '.github/workflows/backend.yml',
        '.github/workflows/deploy.yml',
      ].includes(path) ||
      path.startsWith('.github/actions/')
    )
      affected = true;
  }
  return { affected, shared };
}

export function validateRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision || ''))
    throw new Error('Invalid release revision.');
  return revision;
}

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function changedPaths(base, head, cwd) {
  validateRevision(head);
  if (base === '0'.repeat(40))
    return git(['ls-tree', '-r', '--name-only', '-z', head], cwd)
      .split('\0')
      .filter(Boolean);
  validateRevision(base);
  // Disable rename detection so moving a file out of a watched directory still triggers CI.
  return git(
    ['diff', '--name-only', '--no-renames', '-z', base, head, '--'],
    cwd,
  )
    .split('\0')
    .filter(Boolean);
}

export function committedPaths(base, head, cwd) {
  validateRevision(base);
  validateRevision(head);
  if (base === '0'.repeat(40)) return changedPaths(base, head, cwd);
  return git(
    [
      'log',
      '--format=',
      '--name-only',
      '--no-renames',
      '--diff-merges=first-parent',
      '-z',
      `${base}..${head}`,
      '--',
    ],
    cwd,
  )
    .split('\0')
    .map((path) => path.replace(/^\n+/, ''))
    .filter(Boolean);
}

export function serverRevisionIsCurrent(revision, head, cwd) {
  validateRevision(revision);
  validateRevision(head);
  try {
    git(['merge-base', '--is-ancestor', revision, head], cwd);
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
  // A newer revert is a newer server release; include merge-only conflict resolutions.
  return !serverScope(committedPaths(revision, head, cwd)).affected;
}
