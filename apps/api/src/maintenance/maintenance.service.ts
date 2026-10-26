import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { importJobSchema, mergePlanSchema } from '@dayline/contracts';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { Clock } from '../records/clock.js';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { AppError } from '../common/app-error.js';

const json = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class MaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private hourlyAt = 0;
  private dailyAt = 0;
  private target: { kind: string; id: string } | undefined;
  private running: Promise<void> | null = null;
  ready = false;
  lastSuccess: string | null = null;
  failures = 0;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async onApplicationBootstrap() {
    // Fail before readiness if the required deletion migration has not been deployed.
    await this.db.user.findFirst({
      select: { deletionRequestedAt: true, deletionDueAt: true },
    });
    // Every process, including restores, drains all due batches before listening.
    await this.run(true);
    this.ready = true;
    if (this.config.maintenanceEnabled) {
      this.timer = setInterval(() => {
        void this.run(false).catch(() => {});
      }, 60000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    return this.running?.catch(() => {});
  }
  assertReady() {
    if (!this.ready)
      throw new AppError(
        503,
        'MAINTENANCE_PENDING',
        '服务正在完成启动维护，请稍后重试。',
      );
  }
  run(startup = false): Promise<void> {
    if (this.running) return this.running;
    const work = (async () => {
      try {
        const now = this.clock.now().getTime(),
          hourly = startup || now >= this.hourlyAt,
          daily = startup || now >= this.dailyAt;
        let more: boolean;
        do {
          more = await this.batch(hourly, daily);
        } while (startup && more);
        if (hourly) this.hourlyAt = now + (more ? 60000 : 3600000);
        if (daily) this.dailyAt = now + (more ? 60000 : 86400000);
        this.lastSuccess = this.clock.now().toISOString();
        const dueUsers = await this.db.user.count({
          where: {
            status: 'pending_deletion',
            deletionDueAt: { lte: this.clock.now() },
          },
        });
        const dueTrash = await this.db.entry.count({
          where: { purgeAfter: { lte: this.clock.now() } },
        });
        this.logger.log({
          code: 'MAINTENANCE_COMPLETE',
          lastSuccess: this.lastSuccess,
          dueUsers,
          dueTrash,
          failures: this.failures,
          hasMore: more,
        });
        this.target = undefined;
      } catch {
        this.failures++;
        this.logger.error({
          message: 'Maintenance batch failed; will retry',
          code: 'MAINTENANCE_FAILED',
          target: this.target,
        });
        throw new AppError(
          503,
          'MAINTENANCE_FAILED',
          '维护尚未完成，请稍后重试。',
        );
      }
    })();
    this.running = work;
    return work.finally(() => {
      if (this.running === work) this.running = null;
    });
  }
  private async lock(tx: Prisma.TransactionClient, ids: string[]) {
    for (const id of [...new Set(ids)].sort())
      await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`;
  }
  async eraseDue(userId: string): Promise<boolean> {
    return this.db.transaction(
      async (tx) => {
        // Merge commits flatten source chains. Recursive read also handles older restored chains.
        const related = await tx.$queryRaw<
          { id: string }[]
        >`WITH RECURSIVE owned AS (SELECT id FROM users WHERE id=${userId}::uuid UNION SELECT u.id FROM users u JOIN owned o ON u.merged_into_user_id=o.id WHERE u.status='merged') SELECT id FROM owned`;
        const ids = related.map((u) => u.id);
        await this.lock(tx, ids);
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (
          !user ||
          user.status !== 'pending_deletion' ||
          !user.deletionDueAt ||
          user.deletionDueAt > this.clock.now()
        )
          return false;
        const users = await tx.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true },
        });
        const identities = await tx.wechatIdentity.findMany({
          where: { userId: { in: ids } },
        });
        await tx.qrRequest.deleteMany({
          where: {
            OR: [
              { initiatorUserId: { in: ids } },
              { confirmedUserId: { in: ids } },
              ...ids.map((id) => ({
                actionContext: { path: ['scannerUserId'], equals: id },
              })),
              ...identities.map((w) => ({
                scannerAppId: w.appId,
                scannerOpenid: w.openid,
              })),
            ],
          },
        });
        await tx.verification.deleteMany({
          where: {
            OR: users.flatMap((u) => [
              { identifier: u.email },
              { identifier: { contains: u.id } },
              { value: { contains: u.id } },
            ]),
          },
        });
        // Cascade relations remove business, credentials, sessions, tasks, mappings and source shells atomically.
        await tx.user.delete({ where: { id: userId } });
        return true;
      },
      { maxWait: 10000, timeout: 60000 },
    );
  }
  private async batch(hourly: boolean, daily: boolean): Promise<boolean> {
    const now = this.clock.now();
    const due = await this.db.user.findMany({
      where: { status: 'pending_deletion', deletionDueAt: { lte: now } },
      select: { id: true },
      take: 100,
      orderBy: { id: 'asc' },
    });
    for (const u of due) {
      this.target = { kind: 'deletion', id: u.id };
      await this.eraseDue(u.id);
    }
    const trash = await this.db.entry.findMany({
      where: { purgeAfter: { lte: now } },
      select: { id: true, userId: true },
      take: 100,
      orderBy: { id: 'asc' },
    });
    for (const userId of [...new Set(trash.map((e) => e.userId))].sort())
      await this.db.transaction(async (tx) => {
        await this.lock(tx, [userId]);
        const result = await tx.entry.deleteMany({
          where: {
            userId,
            id: {
              in: trash.filter((e) => e.userId === userId).map((e) => e.id),
            },
            purgeAfter: { lte: this.clock.now() },
          },
        });
        if (result.count)
          await tx.user.update({
            where: { id: userId },
            data: { dataVersion: { increment: 1 } },
          });
      });
    if (!hourly && !daily) return due.length === 100 || trash.length === 100;
    const imports = await this.db.importJob.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { input: { not: Prisma.DbNull } },
          { plan: { path: ['rows'], not: [] } },
          { plan: { path: ['categoryMappings'], not: [] } },
        ],
      },
      take: 100,
      orderBy: { id: 'asc' },
    });
    for (const row of imports)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'imports', id: row.id };
        await this.lock(tx, [row.userId]);
        const current = await tx.importJob.findUnique({
          where: { id: row.id },
        });
        if (!current || current.expiresAt > this.clock.now()) return;
        const plan = importJobSchema.parse(current.plan);
        if (plan.status === 'preview') plan.status = 'expired';
        plan.rows = [];
        plan.categoryMappings = [];
        plan.canCommit = false;
        await tx.importJob.update({
          where: { id: row.id },
          data: { status: plan.status, input: Prisma.DbNull, plan: json(plan) },
        });
      });
    const merges = daily
      ? await this.db.accountMerge.findMany({
          where: {
            OR: [
              {
                recoveryExpiresAt: { lte: now },
                OR: [
                  { recoverySnapshot: { not: Prisma.DbNull } },
                  { plan: { path: ['sourceSummary', 'displayName'], not: '' } },
                  { plan: { path: ['entries'], not: [] } },
                ],
              },
              {
                status: { not: 'committed' },
                expiresAt: { lte: now },
                plan: { path: ['sourceSummary', 'displayName'], not: '' },
              },
            ],
          },
          take: 100,
          orderBy: { id: 'asc' },
        })
      : [];
    for (const row of merges)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'merges', id: row.id };
        await this.lock(tx, [row.sourceUserId, row.targetUserId]);
        const current = await tx.accountMerge.findUnique({
          where: { id: row.id },
        });
        if (
          !current ||
          (current.status === 'committed'
            ? !current.recoveryExpiresAt ||
              current.recoveryExpiresAt > this.clock.now()
            : current.expiresAt > this.clock.now())
        )
          return;
        const plan = mergePlanSchema.parse(current.plan);
        if (plan.status === 'preview') plan.status = 'expired';
        plan.entries = [];
        plan.targetEntries = [];
        plan.focusDays = [];
        plan.targetFocusDays = [];
        plan.targetCategories = [];
        plan.categoryMappings = [];
        plan.sourceSummary.displayName = '';
        plan.sourceSummary.email = null;
        plan.targetSummary.displayName = '';
        plan.targetSummary.email = null;
        plan.canCommit = false;
        await tx.accountMerge.update({
          where: { id: row.id },
          data: {
            status: plan.status,
            plan: json(plan),
            recoverySnapshot: Prisma.DbNull,
          },
        });
      });
    const qrs = await this.db.qrRequest.findMany({
      where: { expiresAt: { lte: now } },
      take: 100,
      select: {
        id: true,
        initiatorUserId: true,
        confirmedUserId: true,
        scannerAppId: true,
        scannerOpenid: true,
      },
    });
    for (const row of qrs)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'qrs', id: row.id };
        const scanner =
          row.scannerAppId && row.scannerOpenid
            ? await tx.wechatIdentity.findUnique({
                where: {
                  appId_openid: {
                    appId: row.scannerAppId,
                    openid: row.scannerOpenid,
                  },
                },
                select: { userId: true },
              })
            : null;
        await this.lock(
          tx,
          [row.initiatorUserId, row.confirmedUserId, scanner?.userId].filter(
            (id): id is string => Boolean(id),
          ),
        );
        await tx.qrRequest.deleteMany({
          where: { id: row.id, expiresAt: { lte: this.clock.now() } },
        });
      });
    const emails = await this.db.emailBindingRequest.findMany({
      where: { expiresAt: { lte: now } },
      take: 100,
      select: { id: true, userId: true },
    });
    for (const row of emails)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'emails', id: row.id };
        await this.lock(tx, [row.userId]);
        await tx.emailBindingRequest.deleteMany({
          where: { id: row.id, expiresAt: { lte: this.clock.now() } },
        });
      });
    const contexts = await this.db.mergeContext.findMany({
      where: { expiresAt: { lte: now } },
      take: 100,
      select: { id: true, initiatorUserId: true, otherUserId: true },
    });
    for (const row of contexts)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'contexts', id: row.id };
        await this.lock(tx, [row.initiatorUserId, row.otherUserId]);
        await tx.mergeContext.deleteMany({
          where: { id: row.id, expiresAt: { lte: this.clock.now() } },
        });
      });
    const sessions = daily
      ? await this.db.session.findMany({
          where: { expiresAt: { lte: now } },
          take: 100,
          select: { id: true, userId: true },
        })
      : [];
    for (const row of sessions)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'sessions', id: row.id };
        await this.lock(tx, [row.userId]);
        await tx.session.deleteMany({
          where: { id: row.id, expiresAt: { lte: this.clock.now() } },
        });
      });
    const verifications = daily
      ? await this.db.verification.findMany({
          where: { expiresAt: { lte: now } },
          take: 100,
          select: { id: true },
        })
      : [];
    for (const row of verifications)
      await this.db.transaction(async (tx) => {
        this.target = { kind: 'verifications', id: row.id };
        const current = await tx.verification.findUnique({
          where: { id: row.id },
        });
        if (!current) return;
        const owners =
          (current.identifier + ':' + current.value).match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          ) ?? [];
        await this.lock(tx, owners);
        await tx.verification.deleteMany({
          where: { id: row.id, expiresAt: { lte: this.clock.now() } },
        });
      });
    return [
      due,
      trash,
      imports,
      merges,
      qrs,
      emails,
      contexts,
      sessions,
      verifications,
    ].some((rows) => rows.length === 100);
  }
}
