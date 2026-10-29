import process from 'node:process';
import console from 'node:console';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPaths,
  committedPaths,
  git,
  serverScope,
  validateRevision,
} from '../deploy/server-scope.mjs';

export function serverPlan(eventName, event, revision, ref, inputs = {}, cwd) {
  validateRevision(revision);
  let scope;
  let mode = 'check';
  if (eventName === 'workflow_dispatch') {
    if (ref !== 'refs/heads/main')
      throw new Error('Run the server workflow from main.');
    mode = inputs.mode || 'publish';
    if (!['publish', 'check', 'retry', 'verify'].includes(mode))
      throw new Error('Invalid server workflow mode.');
    if (
      ['retry', 'verify'].includes(mode) &&
      !/^[1-9]\d*$/.test(inputs.release_run_id || '')
    )
      throw new Error(
        'Retry/verify requires the source server workflow run ID.',
      );
    if (!['retry', 'verify'].includes(mode) && inputs.release_run_id)
      throw new Error('A release run ID is only used with retry/verify.');
    scope = {
      affected: !['retry', 'verify'].includes(mode),
      shared: !['retry', 'verify'].includes(mode),
    };
  } else if (eventName === 'push') {
    if (ref !== 'refs/heads/main' || event.after !== revision)
      throw new Error('Expected a main push for this commit.');
    scope = serverScope([
      ...changedPaths(event.before, revision, cwd),
      ...committedPaths(event.before, revision, cwd),
    ]);
    mode = 'publish';
  } else if (eventName === 'pull_request') {
    const base = validateRevision(event.pull_request?.base?.sha);
    const head = validateRevision(event.pull_request?.head?.sha);
    const ancestor = git(['merge-base', base, head], cwd).trim();
    scope = serverScope(changedPaths(ancestor, head, cwd));
  } else throw new Error('Unsupported server workflow event.');
  return {
    ...scope,
    mode,
    checks: scope.affected,
    build: scope.affected && mode === 'publish',
    prepare:
      mode !== 'check' &&
      (scope.affected || ['retry', 'verify'].includes(mode)),
  };
}

async function main() {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  const plan = serverPlan(
    process.env.GITHUB_EVENT_NAME,
    event,
    process.env.GITHUB_SHA,
    process.env.GITHUB_REF,
    event.inputs,
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(plan)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `Server scope: **${plan.affected ? 'related changes / forced checks' : 'no server changes'}**. Mode: \`${plan.mode}\`.\n\n${plan.checks ? 'Run Web/API checks; shared changes also check Mini compatibility.' : 'Skip checks and builds.'}\n`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
