import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import {
  git,
  changedPaths,
  serverScope,
  serverRevisionIsCurrent,
} from '../deploy/server-scope.mjs';
import { serverPlan } from './server-changes.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dayline-server-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main'], cwd);
  git(['config', 'user.name', 'CI'], cwd);
  git(['config', 'user.email', 'ci@example.test'], cwd);
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(['add', '-A'], cwd);
    git(
      [
        '-c',
        'user.name=CI',
        '-c',
        'user.email=ci@example.test',
        'commit',
        '-qm',
        'fixture',
      ],
      cwd,
    );
    return git(['rev-parse', 'HEAD'], cwd).trim();
  };
  const base = commit({ 'README.md': 'initial' });
  return { cwd, base, commit };
}

test('server scope routes both apps, shared/config changes and infrastructure without mini/docs releases', () => {
  for (const path of [
    'apps/web/src/main.ts',
    'apps/api/prisma/migrations/new/migration.sql',
    'infra/nginx/host.conf.template',
    'scripts/deploy/apply.sh',
    'scripts/ci/server-changes.mjs',
    'Dockerfile',
    '.dockerignore',
    'compose.production.yaml',
    '.github/workflows/server.yml',
    '.github/workflows/deploy.yml',
  ])
    assert.deepEqual(
      serverScope([path]),
      { affected: true, shared: false },
      path,
    );
  for (const path of [
    'packages/contracts/src/index.ts',
    'packages/core/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    '.node-version',
    'eslint.config.mjs',
  ])
    assert.deepEqual(
      serverScope([path]),
      { affected: true, shared: true },
      path,
    );
  assert.deepEqual(
    serverScope([
      'docs/deployment.md',
      'AGENTS.md',
      'README.md',
      'apps/miniapp/src/App.vue',
      '.github/workflows/miniapp.yml',
      'scripts/miniapp/upload.mjs',
    ]),
    { affected: false, shared: false },
  );
});

test('main push examines the whole push, even if its final commit only changes the Mini app', (t) => {
  const { cwd, base, commit } = repository(t);
  commit({ 'apps/web/src/main.ts': 'web' });
  const head = commit({ 'apps/miniapp/src/App.vue': 'mini' });
  const plan = serverPlan(
    'push',
    { before: base, after: head },
    head,
    'refs/heads/main',
    {},
    cwd,
  );
  assert.equal(plan.checks, true);
  assert.equal(plan.build, true);
  assert.equal(plan.shared, false);
  assert.equal(plan.prepare, true);
  const docs = commit({ 'docs/note.md': 'docs' });
  assert.equal(
    serverPlan(
      'push',
      { before: head, after: docs },
      docs,
      'refs/heads/main',
      {},
      cwd,
    ).checks,
    false,
  );
});

test('routing has no 300-file limit and includes deletions/renames out of watched directories', (t) => {
  const { cwd, base, commit } = repository(t);
  const files = Object.fromEntries(
    Array.from({ length: 350 }, (_, i) => [`docs/${i}.md`, 'docs']),
  );
  files['apps/web/src/with\nnewline.ts'] = 'web';
  const head = commit(files);
  assert.equal(changedPaths(base, head, cwd).length, 351);
  assert.equal(serverScope(changedPaths(base, head, cwd)).affected, true);
  renameSync(
    join(cwd, 'apps/web/src/with\nnewline.ts'),
    join(cwd, 'docs/moved.ts'),
  );
  const moved = commit({ 'docs/note.md': 'note' });
  assert.equal(serverScope(changedPaths(head, moved, cwd)).affected, true);
  const first = changedPaths('0'.repeat(40), head, cwd);
  assert.equal(serverScope(first).affected, true);
});

test('PR routing uses the merge base rather than unrelated new changes on main', (t) => {
  const { cwd, base, commit } = repository(t);
  const main = commit({ 'apps/web/src/main.ts': 'main-only' });
  git(['checkout', '-qb', 'feature', base], cwd);
  const head = commit({ 'apps/miniapp/src/App.vue': 'mini-only' });
  const plan = serverPlan(
    'pull_request',
    { pull_request: { base: { sha: main }, head: { sha: head } } },
    head,
    'refs/pull/1/merge',
    {},
    cwd,
  );
  assert.equal(plan.checks, false);
  assert.equal(plan.build, false);
});

test('a revert-and-reapply push still schedules the release that freshness checks require', (t) => {
  const { cwd, commit } = repository(t);
  const before = commit({ 'apps/web/src/main.ts': 'v2' });
  commit({ 'apps/web/src/main.ts': 'v1' });
  const after = commit({ 'apps/web/src/main.ts': 'v2' });
  assert.deepEqual(changedPaths(before, after, cwd), []);
  assert.equal(serverRevisionIsCurrent(before, after, cwd), false);
  assert.equal(
    serverPlan('push', { before, after }, after, 'refs/heads/main', {}, cwd)
      .build,
    true,
  );
});

test('merge-only server changes are not mistaken for unrelated documentation', (t) => {
  const { cwd, commit } = repository(t);
  const revision = commit({ 'apps/web/src/main.ts': 'release' });
  git(['checkout', '-qb', 'feature'], cwd);
  commit({ 'docs/feature.md': 'feature docs' });
  git(['checkout', '-q', 'main'], cwd);
  const before = commit({ 'docs/main.md': 'main docs' });
  git(['merge', '--no-ff', '--no-commit', 'feature'], cwd);
  const merged = commit({ 'apps/web/src/main.ts': 'merge resolution' });
  assert.equal(serverRevisionIsCurrent(revision, merged, cwd), false);
  assert.equal(
    serverPlan(
      'push',
      { before, after: merged },
      merged,
      'refs/heads/main',
      {},
      cwd,
    ).checks,
    true,
  );
});

test('manual checks force verification without publishing; retry and verify require an explicit run', () => {
  const sha = 'a'.repeat(40);
  const check = serverPlan('workflow_dispatch', {}, sha, 'refs/heads/main', {
    mode: 'check',
  });
  assert.equal(check.checks, true);
  assert.equal(check.shared, true);
  assert.equal(check.build, false);
  assert.equal(check.prepare, false);
  const publish = serverPlan('workflow_dispatch', {}, sha, 'refs/heads/main', {
    mode: 'publish',
  });
  assert.equal(publish.build, true);
  assert.equal(publish.prepare, true);
  for (const mode of ['retry', 'verify']) {
    assert.throws(() =>
      serverPlan('workflow_dispatch', {}, sha, 'refs/heads/main', { mode }),
    );
    const reuse = serverPlan('workflow_dispatch', {}, sha, 'refs/heads/main', {
      mode,
      release_run_id: '123',
    });
    assert.equal(reuse.checks, false);
    assert.equal(reuse.build, false);
    assert.equal(reuse.prepare, true);
  }
  assert.throws(() =>
    serverPlan('workflow_dispatch', {}, sha, 'refs/heads/feature', {
      mode: 'publish',
    }),
  );
  assert.throws(() =>
    serverPlan('workflow_dispatch', {}, sha, 'refs/heads/main', {
      mode: 'publish',
      release_run_id: '123',
    }),
  );
  assert.throws(() =>
    serverPlan('push', { before: sha, after: sha }, sha, 'refs/heads/feature'),
  );
  assert.throws(() => serverPlan('workflow_run', {}, sha, 'refs/heads/main'));
});

test('unrelated newer commits do not suppress a prepared server release; newer server/config changes do', (t) => {
  const { cwd, commit } = repository(t);
  const release = commit({
    'apps/web/src/main.ts': 'release',
    'apps/api/src/main.ts': 'initial server',
  });
  assert.equal(serverRevisionIsCurrent(release, release, cwd), true);
  const mini = commit({
    'apps/miniapp/src/App.vue': 'mini',
    'docs/note.md': 'docs',
  });
  assert.equal(serverRevisionIsCurrent(release, mini, cwd), true);
  const newer = commit({ 'apps/api/src/main.ts': 'new server' });
  assert.equal(serverRevisionIsCurrent(release, newer, cwd), false);
  const reverted = commit({ 'apps/api/src/main.ts': 'initial server' });
  assert.equal(
    serverScope(changedPaths(release, reverted, cwd)).affected,
    false,
  );
  assert.equal(serverRevisionIsCurrent(release, reverted, cwd), false);
  const config = commit({ 'pnpm-lock.yaml': 'new dependencies' });
  assert.equal(serverRevisionIsCurrent(newer, config, cwd), false);
});

test('deployment CLI refreshes main before allowing an older image and rejects newer server changes', (t) => {
  const { cwd, commit } = repository(t);
  const revision = commit({ 'apps/web/src/main.ts': 'release' });
  const head = commit({ 'docs/note.md': 'later documentation' });
  const remote = mkdtempSync(join(tmpdir(), 'dayline-server-origin-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(['init', '--bare', '-q', remote], cwd);
  git(['remote', 'add', 'origin', remote], cwd);
  git(['push', '-q', 'origin', 'main'], cwd);
  const output = join(remote, 'output');
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'Geminorun/dayline',
    GITHUB_SHA: head,
    RELEASE_REVISION: revision,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(remote, 'summary'),
  };
  const cli = () =>
    execFileSync(
      process.execPath,
      [resolve('scripts/deploy/release.mjs'), 'current'],
      { cwd, env, stdio: 'pipe' },
    );
  cli();
  assert.equal(
    git(['rev-parse', 'refs/remotes/origin/main'], cwd).trim(),
    head,
  );
  const newer = commit({ 'apps/api/src/main.ts': 'new server' });
  git(['push', '-q', 'origin', 'main'], cwd);
  cli();
  assert.equal(
    git(['rev-parse', 'refs/remotes/origin/main'], cwd).trim(),
    newer,
  );
  assert.equal(readFileSync(output, 'utf8'), 'current=true\ncurrent=false\n');
});

test('force-pushed history cannot authorize a release outside main; missing commits fail closed', (t) => {
  const { cwd, base, commit } = repository(t);
  const release = commit({ 'apps/web/src/main.ts': 'release' });
  git(['checkout', '-qb', 'replacement', base], cwd);
  const head = commit({ 'docs/note.md': 'another history' });
  assert.equal(serverRevisionIsCurrent(release, head, cwd), false);
  assert.throws(() => serverRevisionIsCurrent('a'.repeat(40), head, cwd));
  assert.throws(() => serverRevisionIsCurrent('main', head, cwd));
});
