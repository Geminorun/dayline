import process from 'node:process';
import console from 'node:console';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function eligibleRun(run, repository, revision) {
  return (
    run?.head_sha === revision &&
    run.head_branch === 'main' &&
    run.head_repository?.full_name?.toLowerCase() ===
      repository.toLowerCase() &&
    run.path === '.github/workflows/backend.yml' &&
    ['push', 'workflow_dispatch'].includes(run.event) &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export function releaseSource(repository, revision, eventName, event) {
  if (eventName !== 'workflow_run') {
    validateContext(repository, revision);
    return { revision };
  }
  const run = event?.workflow_run;
  validateContext(repository, run?.head_sha);
  if (run.event !== 'push' || !eligibleRun(run, repository, run.head_sha))
    throw new Error(
      'Automatic deployment requires successful main push CI from this repository.',
    );
  return { revision: run.head_sha, runId: run.id, runAttempt: run.run_attempt };
}

export async function selectReleaseRun(
  repository,
  revision,
  getJson,
  source = {},
) {
  validateContext(repository, revision);
  const runs =
    source.runId !== undefined
      ? [await getJson(`/repos/${repository}/actions/runs/${source.runId}`)]
      : ((
          await getJson(
            `/repos/${repository}/actions/workflows/backend.yml/runs?head_sha=${revision}&branch=main&status=success&per_page=30`,
          )
        ).workflow_runs ?? []);
  for (const run of runs) {
    if (
      !eligibleRun(run, repository, revision) ||
      (source.runId !== undefined && run.id !== source.runId) ||
      (source.runAttempt !== undefined && run.run_attempt !== source.runAttempt)
    )
      continue;
    const { artifacts = [] } = await getJson(
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    if (
      artifacts.some(
        (artifact) =>
          artifact.name === `dayline-release-${revision}` &&
          artifact.expired === false &&
          artifact.workflow_run?.id === run.id &&
          artifact.workflow_run?.head_sha === revision,
      )
    )
      return { runId: run.id, runAttempt: run.run_attempt };
  }
  throw new Error(
    'No prepared release for this commit. Wait for Dayline checks to succeed on main, or run Dayline checks once if its release artifact has expired.',
  );
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

export async function automaticReleaseIsCurrent(repository, revision, getJson) {
  validateContext(repository, revision);
  const ref = await getJson(`/repos/${repository}/git/ref/heads/main`);
  validateContext(repository, ref?.object?.sha);
  return ref.object.sha === revision;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const source = releaseSource(
    repository,
    process.env.GITHUB_SHA,
    process.env.GITHUB_EVENT_NAME,
    process.env.GITHUB_EVENT_NAME === 'workflow_run'
      ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
      : undefined,
  );
  const { revision } = source;
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Prepare and deploy releases from main.');
  const mode = process.argv[2];
  const output = async (values) =>
    appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  if (mode === 'select') {
    const selected = await selectReleaseRun(
      repository,
      revision,
      getGitHubJson,
      source,
    );
    await output({
      revision,
      run_id: selected.runId,
      run_attempt: selected.runAttempt,
    });
  } else if (mode === 'current') {
    const current =
      process.env.GITHUB_EVENT_NAME !== 'workflow_run' ||
      (await automaticReleaseIsCurrent(repository, revision, getGitHubJson));
    await output({ current: String(current) });
    if (!current)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Skipped automatic deployment of \`${revision}\`: main has a newer commit.\n`,
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
        runId: source.runId ?? Number(process.env.RELEASE_RUN_ID),
        runAttempt:
          source.runAttempt ?? Number(process.env.RELEASE_RUN_ATTEMPT),
      },
    );
    await output({ image: release.image });
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Prepared release: \`${revision}\`\n\nImage: \`${release.image}\`\n\n[Successful CI run](https://github.com/${repository}/actions/runs/${release.runId})\n`,
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
