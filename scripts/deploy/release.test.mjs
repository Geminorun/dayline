import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  runAttempt: 2,
};
const expected = { repository, revision, runId: 123, runAttempt: 2 };
const run = {
  id: 123,
  run_attempt: 2,
  head_sha: revision,
  head_branch: 'main',
  head_repository: { full_name: repository },
  path: '.github/workflows/backend.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
const artifact = {
  name: `dayline-release-${revision}`,
  expired: false,
  workflow_run: { id: 123, head_sha: revision },
};

test('release manifest fixes the exact repository, SHA, successful run attempt and image digest', () => {
  assert.equal(validateRelease(release, expected), release);
  for (const override of [
    { version: 2 },
    { repository: 'someone/else' },
    { revision: 'c'.repeat(40) },
    { runId: 124 },
    { runAttempt: 1 },
    { runId: '123' },
    { image: 'ghcr.io/geminorun/dayline:latest' },
    { image: 'ghcr.io/someone/else@sha256:' + 'b'.repeat(64) },
    { image: image + '\n' },
    { image: image + 'extra' },
  ])
    assert.throws(() => validateRelease({ ...release, ...override }, expected));
  assert.throws(() => validateRelease(null, expected));
});

test('release selection finds the retained manifest from successful main CI for the exact SHA', async () => {
  const paths = [];
  const result = await selectReleaseRun(repository, revision, async (path) => {
    paths.push(path);
    return paths.length === 1
      ? { workflow_runs: [run] }
      : { artifacts: [artifact] };
  });
  assert.deepEqual(result, { runId: 123, runAttempt: 2 });
  assert.ok(paths[0].includes(`head_sha=${revision}`));
  assert.equal(
    paths[1],
    `/repos/${repository}/actions/runs/123/artifacts?per_page=100`,
  );
});

test('PR, wrong branch/repository/SHA/workflow, unfinished and unsuccessful runs cannot prepare a release', async () => {
  for (const override of [
    { event: 'pull_request' },
    { event: 'workflow_run' },
    { head_branch: 'work' },
    { head_repository: { full_name: 'someone/else' } },
    { head_sha: 'c'.repeat(40) },
    { path: '.github/workflows/deploy.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { id: '../other' },
    { run_attempt: 0 },
  ]) {
    let calls = 0;
    await assert.rejects(
      selectReleaseRun(repository, revision, async () => {
        calls++;
        return { workflow_runs: [{ ...run, ...override }] };
      }),
      /No prepared release/,
    );
    assert.equal(calls, 1);
  }
});

test('expired, unrelated and missing artifacts fail before server credentials are used', async () => {
  for (const artifacts of [
    [],
    [{ ...artifact, expired: true }],
    [{ ...artifact, name: 'docker-build-record' }],
    [{ ...artifact, workflow_run: { id: 124, head_sha: revision } }],
    [{ ...artifact, workflow_run: { id: 123, head_sha: 'c'.repeat(40) } }],
  ]) {
    await assert.rejects(
      selectReleaseRun(repository, revision, async (path) =>
        path.includes('/artifacts?') ? { artifacts } : { workflow_runs: [run] },
      ),
      /run Dayline checks once/,
    );
  }
});

test('a retained earlier successful run of the same commit can be reused', async () => {
  const result = await selectReleaseRun(repository, revision, async (path) => {
    if (path.includes('/runs?'))
      return {
        workflow_runs: [
          { ...run, id: 124 },
          { ...run, event: 'workflow_dispatch' },
        ],
      };
    return { artifacts: path.includes('/124/') ? [] : [artifact] };
  });
  assert.deepEqual(result, { runId: 123, runAttempt: 2 });
});

test('manifest CLI writes and reads Actions metadata and rejects a different run attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-release-'));
  const manifest = join(directory, 'release.json');
  const output = join(directory, 'output');
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: revision,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    RELEASE_RUN_ID: '123',
    RELEASE_RUN_ATTEMPT: '2',
    DAYLINE_IMAGE: image,
    RELEASE_MANIFEST: manifest,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
  };
  try {
    execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'write'], {
      env,
    });
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), release);
    execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'read'], {
      env,
    });
    assert.equal(await readFile(output, 'utf8'), `image=${image}\n`);
    assert.throws(() =>
      execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'read'], {
        env: { ...env, RELEASE_RUN_ATTEMPT: '3' },
        stdio: 'pipe',
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'write'], {
        env: { ...env, GITHUB_REF: 'refs/heads/work' },
        stdio: 'pipe',
      }),
    );
    assert.equal(await readFile(output, 'utf8'), `image=${image}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
