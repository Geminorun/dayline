import process from 'node:process';
import console from 'node:console';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, serverRevisionIsCurrent } from './server-scope.mjs';

function validateContext(repository, revision) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || ''))
    throw new Error('Invalid release repository.');
  if (!/^[a-f0-9]{40}$/.test(revision || ''))
    throw new Error('Invalid release revision.');
}

export function validateRelease(release, expected) {
  validateContext(expected.repository, expected.revision);
  if (
    release?.version !== 1 ||
    release.repository !== expected.repository ||
    release.revision !== expected.revision ||
    !Number.isSafeInteger(release.runId) ||
    release.runId < 1 ||
    !Number.isSafeInteger(release.runAttempt) ||
    release.runAttempt < 1 ||
    (expected.runId !== undefined && release.runId !== expected.runId) ||
    (expected.runAttempt !== undefined &&
      release.runAttempt !== expected.runAttempt)
  )
    throw new Error(
      'Release manifest does not match the selected CI run and commit.',
    );
  const prefix = `ghcr.io/${expected.repository.toLowerCase()}@sha256:`;
  if (
    typeof release.image !== 'string' ||
    !release.image.startsWith(prefix) ||
    !/^[a-f0-9]{64}$/.test(release.image.slice(prefix.length))
  )
    throw new Error(
      "Release must use this repository's immutable GHCR image digest.",
    );
  return release;
}

/** A failed SSH deployment may reuse a run whose checks, image and gate succeeded. */
export async function selectReleaseRun(repository, runId, getJson) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || '') ||
    !Number.isSafeInteger(runId) ||
    runId < 1
  )
    throw new Error('Invalid source server workflow run.');
  const run = await getJson(`/repos/${repository}/actions/runs/${runId}`);
  validateContext(repository, run?.head_sha);
  if (
    run.id !== runId ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name?.toLowerCase() !==
      repository.toLowerCase() ||
    run.path !== '.github/workflows/server.yml' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    throw new Error(
      'Source must be a completed main server workflow from this repository.',
    );
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await getJson(
      `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.jobs))
      throw new Error('Missing source workflow jobs.');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
    if (page === 10) throw new Error('Too many workflow jobs to validate.');
  }
  const required = ['Web/API checks', 'Prepare image', 'Server result'].map(
    (name) => {
      const matches = jobs.filter((job) => job.name === name);
      const job = matches[0];
      if (
        matches.length !== 1 ||
        job.status !== 'completed' ||
        job.conclusion !== 'success' ||
        job.run_id !== runId ||
        job.head_sha !== run.head_sha ||
        !Number.isSafeInteger(job.run_attempt) ||
        job.run_attempt < 1 ||
        job.run_attempt > run.run_attempt
      )
        throw new Error(`Source server gate did not succeed: ${name}.`);
      return job;
    },
  );
  const { artifacts = [] } = await getJson(
    `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (
    !artifacts.some(
      (artifact) =>
        artifact.name === `dayline-release-${run.head_sha}` &&
        artifact.expired === false &&
        artifact.workflow_run?.id === runId &&
        artifact.workflow_run?.head_sha === run.head_sha,
    )
  )
    throw new Error(
      'Source release artifact is missing or expired; run publish to prepare a new image.',
    );
  return { revision: run.head_sha, runId, runAttempt: required[1].run_attempt };
}

async function getGitHubJson(repositoryPath) {
  if (!process.env.GITHUB_TOKEN)
    throw new Error('Missing GitHub Actions token.');
  const response = await fetch(`https://api.github.com${repositoryPath}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: globalThis.AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const revision = process.env.RELEASE_REVISION || process.env.GITHUB_SHA;
  validateContext(repository, revision);
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
  )
    throw new Error('Prepare and deploy releases from main push/manual runs.');
  const mode = process.argv[2];
  const output = async (values) =>
    appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  if (mode === 'select') {
    let source;
    if (['retry', 'verify'].includes(process.env.RELEASE_MODE)) {
      source = await selectReleaseRun(
        repository,
        Number(process.env.RELEASE_SOURCE_RUN),
        getGitHubJson,
      );
    } else {
      if (process.env.RELEASE_MODE !== 'publish')
        throw new Error('Expected publish, retry or verify release mode.');
      const runId = Number(process.env.GITHUB_RUN_ID),
        runAttempt = Number(process.env.BUILD_RUN_ATTEMPT);
      if (
        !Number.isSafeInteger(runId) ||
        runId < 1 ||
        !Number.isSafeInteger(runAttempt) ||
        runAttempt < 1 ||
        runAttempt > Number(process.env.GITHUB_RUN_ATTEMPT)
      )
        throw new Error('Missing successful image job metadata.');
      source = { revision, runId, runAttempt };
    }
    await output({
      revision: source.revision,
      run_id: source.runId,
      run_attempt: source.runAttempt,
    });
  } else if (mode === 'current') {
    git([
      'fetch',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    const head = git(['rev-parse', 'refs/remotes/origin/main']).trim();
    const current = serverRevisionIsCurrent(revision, head);
    await output({ current: String(current) });
    if (!current)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Skipped deployment of \`${revision}\`: main contains a newer server change or no longer contains this commit.\n`,
      );
  } else if (mode === 'write') {
    const release = validateRelease(
      {
        version: 1,
        repository,
        revision,
        image: process.env.DAYLINE_IMAGE,
        runId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
      { repository, revision },
    );
    const path = process.env.RELEASE_MANIFEST;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(release, null, 2) + '\n');
  } else if (mode === 'read') {
    const release = validateRelease(
      JSON.parse(await readFile(process.env.RELEASE_MANIFEST, 'utf8')),
      {
        repository,
        revision,
        runId: Number(process.env.RELEASE_RUN_ID),
        runAttempt: Number(process.env.RELEASE_RUN_ATTEMPT),
      },
    );
    await output({ image: release.image, revision });
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Validated server release: \`${revision}\`\n\nImage: \`${release.image}\`\n\n[Source workflow](https://github.com/${repository}/actions/runs/${release.runId})\n`,
    );
  } else
    throw new Error(
      'Expected release command: select, current, write or read.',
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Release lookup failed.',
    );
    process.exitCode = 1;
  });
}
