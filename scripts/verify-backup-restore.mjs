import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnvironment } from '../apps/api/dist/config/environment.js';
import { createApp } from '../apps/api/dist/app.factory.js';
import { PrismaService } from '../apps/api/dist/database/prisma.service.js';
import { AuthAdapter } from '../apps/api/dist/auth/adapter/auth-adapter.js';
import { MaintenanceService } from '../apps/api/dist/maintenance/maintenance.service.js';
const require = createRequire(
    new URL('../apps/api/package.json', import.meta.url),
  ),
  { Client } = require('pg');
const base = loadEnvironment(),
  sourceUrl = process.env.TEST_DATABASE_URL;
assert.ok(
  sourceUrl && new URL(sourceUrl).pathname.endsWith('_test'),
  'Requires dedicated _test source',
);
const sourceName = new URL(sourceUrl).pathname.slice(1),
  run = randomUUID(),
  suffix = new Date().toISOString().replace(/\D/g, '').slice(0, 14),
  restoreName = `dayline_restore_${suffix}_${run.slice(0, 8)}_test`;
assert.match(restoreName, /^dayline_restore_\d{14}_[a-f0-9]{8}_test$/);
const cloneUrl = new URL(sourceUrl);
cloneUrl.pathname = '/' + restoreName;
await mkdir('.local/stage7/backups', { recursive: true, mode: 0o700 });
await chmod('.local/stage7/backups', 0o700);
const backup = `.local/stage7/backups/${suffix}-${run}.dump`,
  fixtureIds = [],
  ids = { target: randomUUID(), source: randomUUID(), due: randomUUID() };
fixtureIds.push(...Object.values(ids));
const fixtureAdapter = {
  async exchangeCode() {
    throw new Error('Unused WeChat');
  },
  async createMiniappCode() {
    throw new Error('Unused QR');
  },
};
const sourceApp = await createApp(
  {
    ...base,
    environment: 'test',
    databaseUrl: sourceUrl,
    rateLimitEnabled: false,
    maintenanceEnabled: false,
  },
  fixtureAdapter,
);
let cloneApp, admin;
const dockerEnvironment = { ...process.env };
for (const name of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
])
  delete dockerEnvironment[name];
function command(binary, args, options = {}) {
  const child = spawn(binary, args, {
    env: dockerEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(binary + ' failed; inspect private local diagnostics'),
          ),
    );
  });
  child.stderr.resume();
  return { child, completed };
}
try {
  await sourceApp.init();
  const db = sourceApp.get(PrismaService),
    now = new Date(),
    expired = new Date(now.getTime() - 1000),
    entryId = randomUUID(),
    trashId = randomUUID(),
    importId = randomUUID(),
    mergeId = randomUUID();
  await db.user.createMany({
    data: [
      {
        id: ids.target,
        name: '恢复目标',
        email: `restore-${run}@example.com`,
        emailVerified: true,
      },
      {
        id: ids.source,
        name: '合并来源',
        email: `source-${run}@identity.dayline.invalid`,
        emailKind: 'internal',
        status: 'merged',
        mergedIntoUserId: ids.target,
      },
      {
        id: ids.due,
        name: '已到期注销',
        email: `due-${run}@identity.dayline.invalid`,
        emailKind: 'internal',
        status: 'pending_deletion',
        deletionRequestedAt: new Date(expired.getTime() - 7 * 86400000),
        deletionDueAt: expired,
      },
    ],
  });
  const category = await db.category.findFirstOrThrow({
    where: { userId: ids.target },
  });
  await db.entry.createMany({
    data: [
      {
        id: entryId,
        userId: ids.target,
        categoryId: category.id,
        title: '恢复活动事项',
        startDate: new Date('2026-01-01'),
      },
      {
        id: trashId,
        userId: ids.target,
        categoryId: category.id,
        title: '恢复回收站',
        startDate: new Date('2026-01-01'),
        deletedAt: now,
        purgeAfter: new Date(now.getTime() + 30 * 86400000),
      },
    ],
  });
  await db.entryFocusDay.createMany({
    data: [
      { entryId, date: new Date('2026-01-01'), focused: true },
      { entryId: trashId, date: new Date('2026-01-01'), focused: false },
    ],
  });
  await db.wechatIdentity.create({
    data: { userId: ids.target, appId: 'restore-fixture', openid: run },
  });
  await db.account.create({
    data: {
      userId: ids.target,
      accountId: ids.target,
      providerId: 'credential',
      password: await sourceApp
        .get(AuthAdapter)
        .hashPassword('Backup-only-password-24!'),
    },
  });
  await sourceApp.get(AuthAdapter).createWechatSession(ids.target);
  const receipt = {
      dataVersion: '1',
      created: 1,
      skipped: 0,
      mappings: [
        {
          sourceKey: 'restore:entry',
          sourceDigest: 'digest',
          targetId: entryId,
        },
      ],
      committedAt: now.toISOString(),
    },
    summary = { entries: 1, categories: 6, focusDays: 1 };
  const importPlan = {
    id: importId,
    clientOperationId: randomUUID(),
    kind: 'csv',
    status: 'committed',
    disposition: 'committed',
    inputDigest: 'digest',
    planDigest: 'digest',
    planRevision: 1,
    baseDataVersion: '1',
    expiresAt: expired.toISOString(),
    canCommit: false,
    sourceSummary: summary,
    targetSummary: summary,
    categoryMappings: [],
    rows: [],
    result: receipt,
  };
  await db.importJob.create({
    data: {
      id: importId,
      userId: ids.target,
      clientOperationId: importPlan.clientOperationId,
      kind: 'csv',
      inputDigest: 'digest',
      authEpoch: 1,
      status: 'committed',
      input: { privateInput: 'must expire' },
      plan: importPlan,
      receipt,
      expiresAt: expired,
    },
  });
  const userSummary = {
    userId: ids.source,
    displayName: '历史私密姓名',
    email: null,
    entries: 1,
    trash: 0,
    categories: 1,
    focusDays: 0,
  };
  const mergePlan = {
    id: mergeId,
    operationId: randomUUID(),
    status: 'committed',
    planRevision: 1,
    planDigest: 'digest',
    expiresAt: expired.toISOString(),
    sourceSummary: userSummary,
    targetSummary: { ...userSummary, userId: ids.target },
    sourceDataVersion: '1',
    targetDataVersion: '1',
    targetCategories: [],
    categoryMappings: [],
    entries: [],
    targetEntries: [],
    targetFocusDays: [],
    focusDays: [],
    canCommit: false,
    conflicts: [],
    counts: { retained: 1, reusedCategories: 0, newCategories: 0 },
    displayNameFrom: 'target',
    result: {
      targetUserId: ids.target,
      sourceUserId: ids.source,
      dataVersion: '1',
      committedAt: now.toISOString(),
      reauthenticate: true,
    },
  };
  await db.accountMerge.create({
    data: {
      id: mergeId,
      initiatorUserId: ids.target,
      sourceUserId: ids.source,
      targetUserId: ids.target,
      operationId: mergePlan.operationId,
      contextId: randomUUID(),
      sourceEpoch: 1,
      targetEpoch: 1,
      sourceDataVersion: 1n,
      targetDataVersion: 1n,
      status: 'committed',
      plan: mergePlan,
      recoverySnapshot: { privateCopy: 'must expire' },
      recoveryExpiresAt: expired,
      expiresAt: expired,
      mapping: {
        create: { mappings: { entries: [{ oldId: entryId, newId: entryId }] } },
      },
    },
  });
  const container = process.env.DAYLINE_DB_CONTAINER || 'dayline-db-1',
    role = decodeURIComponent(new URL(sourceUrl).username);
  const dump = command('docker', [
    '--host=unix:///var/run/docker.sock',
    'exec',
    container,
    'pg_dump',
    '-U',
    role,
    '-d',
    sourceName,
    '-Fc',
  ]);
  await pipeline(dump.child.stdout, createWriteStream(backup, { mode: 0o600 }));
  await dump.completed;
  admin = new Client({ connectionString: sourceUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${restoreName}"`);
  const restore = command('docker', [
    '--host=unix:///var/run/docker.sock',
    'exec',
    '-i',
    container,
    'pg_restore',
    '-U',
    role,
    '-d',
    restoreName,
    '--no-owner',
    '--exit-on-error',
  ]);
  restore.child.stdout.resume();
  await pipeline(createReadStream(backup), restore.child.stdin);
  await restore.completed;
  const migrate = command(
    'pnpm',
    [
      '--filter',
      '@dayline/api',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
    { env: { ...process.env, TEST_DATABASE_URL: cloneUrl.toString() } },
  );
  migrate.child.stdout.resume();
  migrate.child.stdin.end();
  await migrate.completed;
  const clone = new Client({ connectionString: cloneUrl.toString() });
  await clone.connect();
  // Restored sessions/standard links predate the recovery decision. Revoke before application readiness.
  await clone.query('BEGIN');
  await clone.query('UPDATE users SET auth_epoch=auth_epoch+1');
  await clone.query('DELETE FROM auth_sessions');
  await clone.query('DELETE FROM auth_verifications');
  await clone.query('COMMIT');
  await clone.end();
  cloneApp = await createApp(
    {
      ...base,
      environment: 'test',
      databaseUrl: cloneUrl.toString(),
      rateLimitEnabled: false,
      maintenanceEnabled: false,
    },
    fixtureAdapter,
  );
  await cloneApp.init();
  const restored = cloneApp.get(PrismaService);
  assert.equal(cloneApp.get(MaintenanceService).ready, true);
  assert.equal(await restored.user.count({ where: { id: ids.due } }), 0);
  assert.equal(
    await restored.category.count({ where: { userId: ids.target } }),
    6,
  );
  assert.equal(
    await restored.entry.count({ where: { userId: ids.target } }),
    2,
  );
  assert.equal(
    await restored.entryFocusDay.count({
      where: { entryId: { in: [entryId, trashId] } },
    }),
    2,
  );
  assert.equal(
    await restored.entry.count({
      where: { id: trashId, deletedAt: { not: null } },
    }),
    1,
  );
  assert.equal(
    await restored.wechatIdentity.count({
      where: { userId: ids.target, openid: run },
    }),
    1,
  );
  assert.equal(
    await restored.account.count({
      where: {
        userId: ids.target,
        accountId: ids.target,
        providerId: 'credential',
      },
    }),
    1,
  );
  assert.equal(await restored.session.count(), 0);
  const job = await restored.importJob.findUniqueOrThrow({
    where: { id: importId },
  });
  assert.equal(job.input, null);
  assert.deepEqual(job.receipt, receipt);
  const history = await restored.accountMerge.findUniqueOrThrow({
    where: { id: mergeId },
    include: { mapping: true },
  });
  assert.equal(history.recoverySnapshot, null);
  assert.equal(history.plan.sourceSummary.displayName, '');
  assert.ok(history.mapping);
  const report = {
    measuredAt: new Date().toISOString(),
    restoreDatabase: restoreName,
    backupPath: backup,
    backupBytes: (await stat(backup)).size,
    mode: (await stat(backup)).mode & 0o777,
    migrations: 8,
    verification: {
      categories: 6,
      entries: 2,
      focusStates: 2,
      trash: 1,
      emailCredential: true,
      wechatIdentity: true,
      sourceShell: true,
      committedReceipt: true,
      mergeMapping: true,
      expiredPrivateCopiesRemoved: true,
      dueAccountErasedBeforeReady: true,
      restoredSessionsRevoked: true,
    },
    preservedOriginalDatabase: true,
    preservedAllVolumes: true,
  };
  await writeFile(
    '.local/stage7/backup-restore.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  if (cloneApp) {
    const db = cloneApp.get(PrismaService);
    await db.user.deleteMany({ where: { id: { in: fixtureIds } } });
    await cloneApp.close();
  }
  const db = sourceApp.get(PrismaService);
  await db.user.deleteMany({ where: { id: { in: fixtureIds } } });
  await sourceApp.close();
  await admin?.end();
}
