import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  validateRelease,
  selectReleaseRun,
  releaseSource,
  automaticReleaseIsCurrent,
} from './release.mjs';

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

test('automatic releases use the triggering CI SHA instead of the workflow default-branch SHA', () => {
  assert.deepEqual(
    releaseSource(repository, 'c'.repeat(40), 'workflow_run', {
      workflow_run: run,
    }),
    { revision, runId: 123, runAttempt: 2 },
  );
  assert.deepEqual(releaseSource(repository, revision, 'workflow_dispatch'), {
    revision,
  });
  for (const override of [
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
    { head_repository: { full_name: 'someone/else' } },
    { head_branch: 'feature' },
    { path: '.github/workflows/untrusted.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { head_sha: 'invalid' },
    { id: 0 },
    { run_attempt: 0 },
  ])
    assert.throws(() =>
      releaseSource(repository, revision, 'workflow_run', {
        workflow_run: { ...run, ...override },
      }),
    );
  assert.throws(() => releaseSource(repository, revision, 'workflow_run', {}));
});

test('automatic releases revalidate only the triggering run and attempt without selecting a different successful run', async () => {
  const paths = [];
  const source = { runId: 123, runAttempt: 2 };
  const result = await selectReleaseRun(
    repository,
    revision,
    async (path) => {
      paths.push(path);
      return path.includes('/artifacts?') ? { artifacts: [artifact] } : run;
    },
    source,
  );
  assert.deepEqual(result, source);
  assert.equal(paths[0], `/repos/${repository}/actions/runs/123`);
  for (const override of [
    { id: 124 },
    { run_attempt: 3 },
    { conclusion: 'failure' },
    { head_sha: 'c'.repeat(40) },
  ]) {
    let calls = 0;
    await assert.rejects(
      selectReleaseRun(
        repository,
        revision,
        async () => {
          calls++;
          return { ...run, ...override };
        },
        source,
      ),
      /No prepared release/,
    );
    assert.equal(calls, 1);
  }
});

test('superseded automatic releases skip SSH deployment and a failed main lookup cannot authorize deployment', async () => {
  for (const sha of [revision, 'c'.repeat(40)]) {
    assert.equal(
      await automaticReleaseIsCurrent(repository, revision, async (path) => {
        assert.equal(path, `/repos/${repository}/git/ref/heads/main`);
        return { object: { sha } };
      }),
      sha === revision,
    );
  }
  await assert.rejects(
    automaticReleaseIsCurrent(repository, revision, async () => ({})),
    /Invalid release revision/,
  );
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
    GITHUB_EVENT_NAME: 'workflow_dispatch',
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
    execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'current'], {
      env,
    });
    assert.equal(
      await readFile(output, 'utf8'),
      `image=${image}\ncurrent=true\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatic manifest CLI validates the source SHA even when GITHUB_SHA points at a newer commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-auto-release-'));
  const output = join(directory, 'output');
  const manifest = join(directory, 'release.json');
  const eventPath = join(directory, 'event.json');
  try {
    await writeFile(manifest, JSON.stringify(release));
    await writeFile(eventPath, JSON.stringify({ workflow_run: run }));
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: 'c'.repeat(40),
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: eventPath,
      RELEASE_RUN_ID: '123',
      RELEASE_RUN_ATTEMPT: '2',
      RELEASE_MANIFEST: manifest,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    };
    execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'read'], {
      env,
    });
    assert.equal(await readFile(output, 'utf8'), `image=${image}\n`);
    await writeFile(manifest, JSON.stringify({ ...release, runId: 124 }));
    assert.throws(() =>
      execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'read'], {
        env: { ...env, RELEASE_RUN_ID: '124' },
        stdio: 'pipe',
      }),
    );
    await writeFile(manifest, JSON.stringify(release));
    await writeFile(
      eventPath,
      JSON.stringify({ workflow_run: { ...run, conclusion: 'failure' } }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, ['scripts/deploy/release.mjs', 'read'], {
        env,
        stdio: 'pipe',
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
