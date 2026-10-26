import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createApp } from '../apps/api/dist/app.factory.js';
import { loadEnvironment } from '../apps/api/dist/config/environment.js';
import { PrismaService } from '../apps/api/dist/database/prisma.service.js';
import { snapshotDtoSchema } from '../packages/contracts/dist/index.js';
import {
  selectEntries,
  timelineWindow,
  timelineFocusGroups,
  visibleRows,
} from '../packages/core/dist/index.js';
const base = loadEnvironment(),
  databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(
  databaseUrl && new URL(databaseUrl).pathname.endsWith('_test'),
  'Requires a dedicated _test database',
);
const run = randomUUID(),
  ids = [],
  reports = [];
const app = await createApp(
  {
    ...base,
    environment: 'test',
    databaseUrl,
    rateLimitEnabled: false,
    maintenanceEnabled: false,
  },
  {
    async exchangeCode(code) {
      return { appId: 'capacity-' + run, openid: code };
    },
    async createMiniappCode() {
      throw new Error('Unused QR');
    },
  },
);
try {
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const db = app.get(PrismaService),
    users = [];
  for (let n = 0; n < 20; n++) {
    const login = await fetch(origin + '/api/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: randomUUID() }),
    });
    assert.equal(login.status, 200);
    const user = (await login.json()).data.user;
    ids.push(user.id);
    const category = await db.category.findFirstOrThrow({
      where: { userId: user.id },
    });
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      id: randomUUID(),
      userId: user.id,
      categoryId: category.id,
      title: `容量样本${i}`,
      startDate: new Date('2026-01-01'),
      endDate: null,
    }));
    await db.entry.createMany({ data: entries });
    const focuses = entries.flatMap((e) =>
      Array.from({ length: 10 }, (_, d) => ({
        entryId: e.id,
        date: new Date(`2026-01-${String(d + 1).padStart(2, '0')}`),
        focused: d !== 9,
      })),
    );
    for (let i = 0; i < focuses.length; i += 1000)
      await db.entryFocusDay.createMany({ data: focuses.slice(i, i + 1000) });
    users.push({
      id: user.id,
      token: login.headers.get('set-auth-token'),
      entryId: entries[0].id,
    });
  }
  const readTimes = [],
    saveTimes = [];
  let representative = '';
  for (let round = 0; round < 5; round++)
    await Promise.all(
      users.map(async (u) => {
        const headers = {
            Authorization: 'Bearer ' + u.token,
            'X-Dayline-Expected-User': u.id,
          },
          start = performance.now();
        const response = await fetch(origin + '/api/v1/snapshot', { headers });
        const text = await response.text();
        assert.equal(response.status, 200);
        readTimes.push(performance.now() - start);
        if (!representative) representative = text;
        const startSave = performance.now();
        const saved = await fetch(origin + '/api/v1/entries/' + u.entryId, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: round + 1,
            title: `容量保存${round}`,
          }),
        });
        await saved.arrayBuffer();
        assert.equal(saved.status, 200);
        saveTimes.push(performance.now() - startSave);
      }),
    );
  const parseStart = performance.now();
  const parsed = JSON.parse(representative);
  const parseMs = performance.now() - parseStart;
  const validateStart = performance.now();
  const snapshot = snapshotDtoSchema.parse(parsed.data);
  const validateMs = performance.now() - validateStart;
  assert.equal(snapshot.entries.length, 1000);
  assert.equal(snapshot.focusDays.length, 10000);
  const compute = performance.now();
  const entries = selectEntries(snapshot.entries, snapshot.businessToday, {
    search: '',
    categoryId: '',
    status: 'all',
    sort: 'desc',
  });
  const window = timelineWindow(
    entries,
    snapshot.businessToday,
    'all',
    snapshot.businessToday,
  );
  const groups = timelineFocusGroups(
    entries,
    snapshot.focusDays,
    snapshot.businessToday,
    window,
  );
  const rows = visibleRows(entries.length, 0, 600, 56);
  const computeMs = performance.now() - compute;
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  reports.push({
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      cpuCount: cpus().length,
      memoryGiB: +(totalmem() / 1024 ** 3).toFixed(2),
      network:
        'loopback HTTP, uncompressed; 20 active users, each 1000 entries/10000 focus states; 5 rounds, reads then CAS saves',
    },
    users: 20,
    entriesPerUser: 1000,
    focusStatesPerUser: 10000,
    snapshotSamples: readTimes.length,
    saveSamples: saveTimes.length,
    snapshotP50Ms: percentile(readTimes, 0.5),
    snapshotP95Ms: percentile(readTimes, 0.95),
    saveP95Ms: percentile(saveTimes, 0.95),
    snapshotBytes: Buffer.byteLength(representative),
    gzipBytes: gzipSync(representative).length,
    jsonParseMs: parseMs,
    contractValidationMs: validateMs,
    initialFilterTimelineMs: computeMs,
    visibleRows: rows,
    ticks: window.ticks.length,
    focusGroups: groups.length,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    productionSla:
      'Not established; repeat on target 2C/4G machine and controlled network',
  });
  await mkdir('.local/stage7', { recursive: true, mode: 0o700 });
  await writeFile(
    '.local/stage7/capacity.json',
    JSON.stringify(reports, null, 2),
    { mode: 0o600 },
  );
  await appendFile(
    '.local/stage7/capacity-runs.jsonl',
    JSON.stringify(reports[0]) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(reports[0]));
} finally {
  const db = app.get(PrismaService);
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
}
