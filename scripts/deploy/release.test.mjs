import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { validateRelease, selectReleaseRun } from './release.mjs';

const repository = 'Geminorun/dayline';
const revision = 'a'.repeat(40);
const image = 'ghcr.io/geminorun/dayline@sha256:' + 'b'.repeat(64);
const release = {
  version: 1,
  repository,
  revision,
  image,
  runId: 123,
  runAttempt: 1,
};
const expected = { repository, revision, runId: 123, runAttempt: 1 };
const run = {
  id: 123,
  run_attempt: 2,
  head_sha: revision,
  head_branch: 'main',
  head_repository: { full_name: repository },
  path: '.github/workflows/server.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
};
const jobs = ['Web/API checks', 'Prepare image', 'Server result'].map(
  (name) => ({
    name,
    run_id: 123,
    run_attempt: 1,
    head_sha: revision,
    status: 'completed',
    conclusion: 'success',
  }),
);
const artifact = {
  name: `dayline-release-${revision}`,
  expired: false,
  workflow_run: { id: 123, head_sha: revision },
};
function source(overrides = {}) {
  return async (path) => {
    if (path.includes('/jobs?')) return { jobs: overrides.jobs ?? jobs };
    if (path.includes('/artifacts?'))
      return { artifacts: overrides.artifacts ?? [artifact] };
    assert.equal(path, `/repos/${repository}/actions/runs/123`);
    return { ...run, ...overrides.run };
  };
}

test('release manifest fixes repository, SHA, build run attempt and immutable image digest', () => {
  assert.equal(validateRelease(release, expected), release);
  for (const override of [
    { version: 2 },
    { repository: 'someone/else' },
    { revision: 'c'.repeat(40) },
    { runId: 124 },
    { runAttempt: 2 },
    { runId: '123' },
    { image: 'ghcr.io/geminorun/dayline:latest' },
    { image: 'ghcr.io/someone/else@sha256:' + 'b'.repeat(64) },
    { image: image + '\n' },
    { image: image + 'extra' },
  ])
    assert.throws(() => validateRelease({ ...release, ...override }, expected));
  assert.throws(() => validateRelease(null, expected));
});

test('retry can reuse a failed deployment only after the checks, image and gate succeeded', async () => {
  assert.deepEqual(await selectReleaseRun(repository, 123, source()), {
    revision,
    runId: 123,
    runAttempt: 1,
  });
  // Re-running a failed deploy does not rebuild the successful attempt-1 image.
  assert.deepEqual(
    await selectReleaseRun(
      repository,
      123,
      source({ run: { event: 'workflow_dispatch', conclusion: 'success' } }),
    ),
    { revision, runId: 123, runAttempt: 1 },
  );
  for (const index of [0, 1, 2]) {
    for (const change of [
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { conclusion: 'skipped' },
      { status: 'in_progress' },
      { run_id: 124 },
      { head_sha: 'c'.repeat(40) },
      { run_attempt: 3 },
    ]) {
      const altered = jobs.map((job, i) =>
        i === index ? { ...job, ...change } : job,
      );
      await assert.rejects(
        selectReleaseRun(repository, 123, source({ jobs: altered })),
        /gate did not succeed/,
      );
    }
  }
  await assert.rejects(
    selectReleaseRun(repository, 123, source({ jobs: jobs.slice(0, 2) })),
    /gate did not succeed/,
  );
});

test('PR, foreign repo/branch/workflow, active or malformed source runs cannot release', async () => {
  for (const override of [
    { event: 'pull_request' },
    { event: 'workflow_run' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'someone/else' } },
    { head_sha: 'invalid' },
    { path: '.github/workflows/backend.yml' },
    { path: '.github/workflows/miniapp.yml' },
    { status: 'in_progress' },
    { id: 124 },
    { run_attempt: 0 },
  ])
    await assert.rejects(
      selectReleaseRun(repository, 123, source({ run: override })),
    );
  for (const id of [0, -1, '123', NaN, 1.5])
    await assert.rejects(selectReleaseRun(repository, id, source()));
});

test('missing/expired/unrelated artifacts fail before server credentials are used', async () => {
  for (const artifacts of [
    [],
    [{ ...artifact, expired: true }],
    [{ ...artifact, name: 'other' }],
    [{ ...artifact, workflow_run: { id: 124, head_sha: revision } }],
    [{ ...artifact, workflow_run: { id: 123, head_sha: 'c'.repeat(40) } }],
  ])
    await assert.rejects(
      selectReleaseRun(repository, 123, source({ artifacts })),
      /missing or expired/,
    );
});

test('retry paginates workflow jobs instead of accepting an incomplete first page', async () => {
  const pages = [];
  const result = await selectReleaseRun(repository, 123, async (path) => {
    if (!path.includes('/jobs?')) return source()(path);
    pages.push(path);
    return {
      jobs: path.endsWith('page=1')
        ? Array.from({ length: 100 }, () => ({ name: 'unrelated' }))
        : jobs,
    };
  });
  assert.equal(result.runAttempt, 1);
  assert.equal(pages.length, 2);
});

test('same-run CLI preserves build metadata across retries and rejects changed manifests or unsafe contexts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-release-'));
  const manifest = join(directory, 'release.json');
  const output = join(directory, 'output');
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: revision,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'push',
    RELEASE_RUN_ID: '123',
    RELEASE_RUN_ATTEMPT: '1',
    RELEASE_MANIFEST: manifest,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    DAYLINE_IMAGE: image,
    RELEASE_MODE: 'publish',
    BUILD_RUN_ATTEMPT: '1',
  };
  const cli = (command, patch = {}) =>
    execFileSync(process.execPath, ['scripts/deploy/release.mjs', command], {
      env: { ...env, ...patch },
      stdio: 'pipe',
    });
  try {
    cli('write');
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), release);
    cli('select', { GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(
      await readFile(output, 'utf8'),
      `revision=${revision}\nrun_id=123\nrun_attempt=1\n`,
    );
    await writeFile(output, '');
    cli('read', { GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(
      await readFile(output, 'utf8'),
      `image=${image}\nrevision=${revision}\n`,
    );
    assert.throws(() => cli('read', { RELEASE_RUN_ATTEMPT: '2' }));
    assert.throws(() => cli('write', { GITHUB_REF: 'refs/heads/work' }));
    assert.throws(() => cli('write', { GITHUB_EVENT_NAME: 'pull_request' }));
    assert.throws(() => cli('select', { BUILD_RUN_ATTEMPT: '3' }));
    assert.throws(() => cli('select', { BUILD_RUN_ATTEMPT: '' }));
    // Explicit source SHA binds an older prepared image, never the dispatch's newer SHA.
    cli('read', {
      GITHUB_SHA: 'c'.repeat(40),
      RELEASE_REVISION: revision,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    await writeFile(manifest, JSON.stringify({ ...release, runId: 124 }));
    assert.throws(() => cli('read'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
