import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_CATEGORIES, businessToday } from '@dayline/core';
import {
  importJobSchema,
  importResultSchema,
  normalizedImportSourceSchema,
} from '@dayline/contracts';
import type {
  GuestAdmissionInput,
  NormalizedImportSource,
  ImportJobDto,
  ImportReviewInput,
  ImportCommitInput,
  ImportResult,
} from '@dayline/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
import { Clock } from '../records/clock.js';
import {
  categoryDto,
  entryDto,
  focusDto,
  databaseDate,
} from '../records/record-dto.js';
type Tx = Prisma.TransactionClient;
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const conflict = (code = 'PREVIEW_STALE') =>
  new AppError(409, code, '接入依据已变化，请重新核对预览。');
@Injectable()
export class ImportsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}
  private async user(tx: Tx, actor: Actor) {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: actor.userId } });
    if (!user || user.authEpoch !== actor.authEpoch || user.status === 'merged')
      throw new AppError(401, 'SESSION_REVOKED', '请重新登录。');
    if (user.status !== 'active')
      throw new AppError(403, 'ACCOUNT_PENDING_DELETION', '账号正在注销。');
    if (!user.initializedAt)
      throw new AppError(503, 'ACCOUNT_NOT_INITIALIZED', '账号尚未准备完成。');
    return user;
  }
  private async cloud(tx: Tx, userId: string) {
    const [categories, entries, focus] = await Promise.all([
      tx.category.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      tx.entry.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      tx.entryFocusDay.findMany({
        where: { entry: { userId } },
        orderBy: [{ entryId: 'asc' }, { date: 'asc' }],
      }),
    ]);
    return {
      categories: categories.map(categoryDto),
      entries: entries.map(entryDto),
      focusDays: focus.map(focusDto),
    };
  }
  private digest(plan: ImportJobDto) {
    return hash({
      ...plan,
      planDigest: '',
      status: 'preview',
      disposition: 'preview_required',
      result: null,
    });
  }
  private async lockedJob(tx: Tx, actor: Actor, id: string) {
    await tx.$queryRaw`SELECT id FROM import_jobs WHERE id=${id}::uuid AND user_id=${actor.userId}::uuid FOR UPDATE`;
    const row = await tx.importJob.findFirst({
      where: { id, userId: actor.userId },
    });
    if (!row) throw new AppError(404, 'RESOURCE_NOT_FOUND', '接入任务不存在。');
    if (row.status !== 'committed' && row.authEpoch !== actor.authEpoch)
      throw new AppError(401, 'SESSION_REVOKED', '请重新准备接入。');
    const plan = importJobSchema.parse(row.plan);
    if (row.status === 'preview' && row.expiresAt <= this.clock.now()) {
      plan.status = 'expired';
      plan.canCommit = false;
      await tx.importJob.update({
        where: { id },
        data: { status: 'expired', plan: json(plan), input: Prisma.DbNull },
      });
    }
    return { row, plan };
  }
  private ready(plan: ImportJobDto, categoryCount: number) {
    const names = plan.categoryMappings
      .filter((c) => !c.targetId)
      .map((c) => c.name);
    plan.canCommit =
      plan.status === 'preview' &&
      !plan.categoryMappings.some((c) => c.needsReview) &&
      !plan.rows.some((r) => r.action === 'needs_review') &&
      categoryCount + names.length <= 20 &&
      new Set(names).size === names.length;
    plan.planDigest = this.digest(plan);
  }
  async prepare(actor: Actor, input: GuestAdmissionInput) {
    const source = input.package;
    return this.prepareNormalized(
      actor,
      'guest',
      input.clientOperationId,
      {
        sourceNamespace: source.guestDatasetId,
        sourceRevision: String(source.packageRevision),
        savedAt: source.savedAt,
        categories: source.categories,
        entries: source.entries,
        focusDays: source.focusDays,
      },
      true,
    );
  }
  /** File parsers in stage 5 call this entry, then use the identical task review/commit endpoints. */
  async prepareNormalized(
    actor: Actor,
    kind: ImportJobDto['kind'],
    clientOperationId: string,
    rawSource: NormalizedImportSource,
    autoIfEmpty = false,
  ) {
    const validation = normalizedImportSourceSchema.safeParse(rawSource);
    if (!validation.success)
      throw new AppError(422, 'IMPORT_INVALID', '归一化导入来源无效。');
    const source = validation.data;
    // Device timestamps are provenance only. Invalid clocks require an explicit repair rather than restoring deleted data.
    const now = this.clock.now(),
      today = businessToday(now);
    if (
      Date.parse(source.savedAt) > now.getTime() + 300_000 ||
      source.entries.some(
        (e) =>
          Date.parse(e.createdAt) > now.getTime() + 300_000 ||
          Date.parse(e.updatedAt) > now.getTime() + 300_000 ||
          (e.deletedAt &&
            (Date.parse(e.deletedAt) > now.getTime() + 300_000 ||
              Date.parse(e.purgeAfter ?? '') - Date.parse(e.deletedAt) !==
                30 * 86400000)),
      ) ||
      source.focusDays.some((f) => f.focused && f.date > today)
    )
      throw new AppError(
        422,
        'IMPORT_INVALID',
        '本机时间或回收站期限不可信，请校准时间后核对原包。',
      );
    const inputDigest = hash({ kind, source });
    const focusByEntry = new Map<string, typeof source.focusDays>();
    for (const focus of source.focusDays) {
      const days = focusByEntry.get(focus.entryId) ?? [];
      days.push(focus);
      focusByEntry.set(focus.entryId, days);
    }
    const preparedRows = source.entries.map((entry) => {
      const focus = (focusByEntry.get(entry.id) ?? []).sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      return {
        entry,
        focus,
        sourceKey: source.sourceNamespace + ':' + entry.id,
        sourceDigest: hash({ entry, focus }),
      };
    });
    return this.db.$transaction(
      async (tx) => {
        const user = await this.user(tx, actor);
        const old = await tx.importJob.findUnique({
          where: {
            userId_clientOperationId: {
              userId: actor.userId,
              clientOperationId: clientOperationId,
            },
          },
        });
        if (old) {
          if (old.inputDigest !== inputDigest)
            throw conflict('IDEMPOTENCY_KEY_REUSED');
          return (await this.lockedJob(tx, actor, old.id)).plan;
        }
        const cloud = await this.cloud(tx, actor.userId);
        const previous = await tx.importJob.findMany({
          where: { userId: actor.userId, kind, status: 'committed' },
          orderBy: { completedAt: 'asc' },
          select: { receipt: true },
        });
        const processed = new Map<string, ImportResult['mappings'][number]>();
        for (const job of previous) {
          const receipt = importResultSchema.safeParse(job.receipt);
          if (receipt.success)
            for (const m of receipt.data.mappings)
              processed.set(m.sourceKey, m);
        }
        const mappings = source.categories.map((c) => {
          const same = cloud.categories.find(
            (t) =>
              t.name === c.name &&
              t.color === c.color &&
              (!c.seedKey || t.seedKey === c.seedKey),
          );
          return {
            sourceId: c.id,
            candidateId: randomUUID(),
            targetId: same?.id ?? null,
            name: c.name,
            color: c.color,
            seedKey: c.seedKey,
            needsReview:
              !same && cloud.categories.some((t) => t.name === c.name),
          };
        });
        const plan: ImportJobDto = {
          id: randomUUID(),
          clientOperationId: clientOperationId,
          kind,
          status: 'preview',
          disposition: 'preview_required',
          inputDigest,
          planDigest: '',
          planRevision: 1,
          baseDataVersion: user.dataVersion.toString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
          canCommit: false,
          sourceSummary: {
            entries: source.entries.length,
            categories: source.categories.length,
            focusDays: source.focusDays.length,
          },
          targetSummary: {
            entries: cloud.entries.length,
            categories: cloud.categories.length,
            focusDays: cloud.focusDays.length,
          },
          categoryMappings: mappings,
          rows: preparedRows.map(
            ({ entry, focus, sourceKey, sourceDigest }) => {
              const prior = processed.get(sourceKey);
              const expired =
                entry.purgeAfter !== null &&
                Date.parse(entry.purgeAfter) <= now.getTime();
              return {
                sourceKey,
                sourceDigest,
                candidateId: randomUUID(),
                source: entry,
                focusDays: focus,
                action:
                  expired || prior?.sourceDigest === sourceDigest
                    ? 'skip'
                    : prior
                      ? 'needs_review'
                      : 'create_copy',
                previousTargetId: prior?.targetId ?? null,
                reason: expired
                  ? '回收站已到期，保留原包并跳过'
                  : prior
                    ? prior.sourceDigest === sourceDigest
                      ? '此来源已接入，跳过（包括已在云端清理的目标）'
                      : '本机来源已有新修改；请明确保留副本或跳过，不覆盖云端'
                    : null,
              };
            },
          ),
          result: null,
        };
        this.ready(plan, cloud.categories.length);
        await tx.importJob.create({
          data: {
            id: plan.id,
            userId: actor.userId,
            kind,
            clientOperationId: clientOperationId,
            inputDigest,
            authEpoch: actor.authEpoch,
            input: json(source),
            plan: json(plan),
            expiresAt: new Date(plan.expiresAt),
          },
        });
        const empty =
          cloud.entries.length === 0 &&
          cloud.focusDays.length === 0 &&
          cloud.categories.length === DEFAULT_CATEGORIES.length &&
          DEFAULT_CATEGORIES.every((seed) =>
            cloud.categories.some(
              (c) =>
                c.seedKey === seed.seedKey &&
                c.name === seed.name &&
                c.color === seed.color,
            ),
          );
        if (autoIfEmpty && empty && plan.canCommit)
          return this.apply(tx, actor, plan, user.dataVersion);
        return plan;
      },
      { timeout: 60_000 },
    );
  }
  async get(actor: Actor, id: string, operation = false) {
    return this.db.$transaction(async (tx) => {
      await this.user(tx, actor);
      const row = operation
        ? await tx.importJob.findUnique({
            where: {
              userId_clientOperationId: {
                userId: actor.userId,
                clientOperationId: id,
              },
            },
          })
        : null;
      if (operation && !row)
        throw new AppError(
          404,
          'RESOURCE_NOT_FOUND',
          '任务尚未建立，可用原包重试。',
        );
      return (await this.lockedJob(tx, actor, row?.id ?? id)).plan;
    });
  }
  async review(actor: Actor, id: string, input: ImportReviewInput) {
    return this.db.$transaction(async (tx) => {
      const user = await this.user(tx, actor),
        { plan } = await this.lockedJob(tx, actor, id);
      if (
        plan.status !== 'preview' ||
        plan.planRevision !== input.expectedPlanRevision
      )
        throw conflict();
      const cloud = await this.cloud(tx, actor.userId);
      if (
        new Set(input.categories.map((c) => c.sourceId)).size !==
          input.categories.length ||
        new Set(input.rows.map((r) => r.sourceKey)).size !== input.rows.length
      )
        throw new AppError(422, 'IMPORT_INVALID', '预览选择重复。');
      for (const choice of input.categories) {
        const mapping = plan.categoryMappings.find(
          (c) => c.sourceId === choice.sourceId,
        );
        if (!mapping) throw conflict();
        const target = choice.targetId
          ? cloud.categories.find((c) => c.id === choice.targetId)
          : null;
        if (choice.targetId && !target) throw conflict();
        if (
          target &&
          (target.name !== choice.name || target.color !== choice.color)
        )
          throw conflict();
        if (!target && cloud.categories.some((c) => c.name === choice.name))
          throw new AppError(
            409,
            'CATEGORY_NAME_EXISTS',
            '请区分类名或明确选择已有分类。',
          );
        Object.assign(mapping, {
          targetId: choice.targetId,
          name: choice.name,
          color: choice.color,
          needsReview: false,
        });
      }
      for (const choice of input.rows) {
        const row = plan.rows.find((r) => r.sourceKey === choice.sourceKey);
        if (!row) throw conflict();
        if (
          row.source.purgeAfter &&
          Date.parse(row.source.purgeAfter) <= this.clock.now().getTime() &&
          choice.action !== 'skip'
        )
          throw new AppError(410, 'TRASH_EXPIRED', '不能延长已到期回收站。');
        row.action = choice.action;
      }
      // Re-reading cloud is an explicit review boundary. Candidates remain stable.
      for (const mapping of plan.categoryMappings)
        if (
          mapping.targetId &&
          !cloud.categories.some(
            (c) =>
              c.id === mapping.targetId &&
              c.name === mapping.name &&
              c.color === mapping.color,
          )
        )
          mapping.needsReview = true;
      plan.baseDataVersion = user.dataVersion.toString();
      plan.planRevision++;
      plan.targetSummary = {
        entries: cloud.entries.length,
        categories: cloud.categories.length,
        focusDays: cloud.focusDays.length,
      };
      this.ready(plan, cloud.categories.length);
      await tx.importJob.update({ where: { id }, data: { plan: json(plan) } });
      return plan;
    });
  }
  async commit(actor: Actor, id: string, input: ImportCommitInput) {
    return this.db.$transaction(
      async (tx) => {
        const user = await this.user(tx, actor),
          { plan } = await this.lockedJob(tx, actor, id);
        if (
          plan.planRevision !== input.expectedPlanRevision ||
          plan.planDigest !== input.planDigest
        )
          throw conflict();
        if (plan.status === 'committed') return plan;
        if (plan.status !== 'preview' || !plan.canCommit)
          throw conflict('IMPORT_REVIEW_REQUIRED');
        if (plan.baseDataVersion !== user.dataVersion.toString())
          throw conflict();
        return this.apply(tx, actor, plan, user.dataVersion);
      },
      { timeout: 60_000 },
    );
  }
  // Stage 5 parsers produce this same validated plan; commit is deliberately shared.
  private async apply(
    tx: Tx,
    actor: Actor,
    plan: ImportJobDto,
    version: bigint,
  ) {
    const now = this.clock.now(),
      categoryIds = new Map<string, string>();
    let changed = false;
    for (const c of plan.categoryMappings) {
      const target = c.targetId ?? c.candidateId;
      categoryIds.set(c.sourceId, target);
      if (!c.targetId) {
        await tx.category.create({
          data: {
            id: target,
            userId: actor.userId,
            name: c.name,
            color: c.color,
            seedKey: null,
          },
        });
        changed = true;
      }
    }
    const mappings: ImportResult['mappings'] = [];
    const newEntries: Prisma.EntryCreateManyInput[] = [],
      newFocus: Prisma.EntryFocusDayCreateManyInput[] = [];
    let created = 0,
      skipped = 0;
    for (const row of plan.rows) {
      if (row.action === 'skip') {
        skipped++;
        if (row.previousTargetId)
          mappings.push({
            sourceKey: row.sourceKey,
            sourceDigest: row.sourceDigest,
            targetId: row.previousTargetId,
          });
        continue;
      }
      if (row.action !== 'create_copy')
        throw conflict('IMPORT_REVIEW_REQUIRED');
      const e = row.source,
        categoryId = categoryIds.get(e.categoryId);
      if (!categoryId)
        throw new AppError(422, 'IMPORT_INVALID', '分类映射缺失。');
      if (e.purgeAfter && Date.parse(e.purgeAfter) <= now.getTime())
        throw conflict();
      newEntries.push({
        id: row.candidateId,
        userId: actor.userId,
        categoryId,
        title: e.title,
        startDate: databaseDate(e.startDate),
        endDate: e.endDate ? databaseDate(e.endDate) : null,
        deletedAt: e.deletedAt ? new Date(e.deletedAt) : null,
        purgeAfter: e.purgeAfter ? new Date(e.purgeAfter) : null,
      });
      for (const f of row.focusDays)
        newFocus.push({
          entryId: row.candidateId,
          date: databaseDate(f.date),
          focused: f.focused,
          version: 1,
          updatedAt: now,
        });
      mappings.push({
        sourceKey: row.sourceKey,
        sourceDigest: row.sourceDigest,
        targetId: row.candidateId,
      });
      created++;
      changed = true;
    }
    for (let offset = 0; offset < newEntries.length; offset += 1000)
      await tx.entry.createMany({
        data: newEntries.slice(offset, offset + 1000),
      });
    for (let offset = 0; offset < newFocus.length; offset += 1000)
      await tx.entryFocusDay.createMany({
        data: newFocus.slice(offset, offset + 1000),
      });
    const dataVersion = changed
      ? (
          await tx.user.update({
            where: { id: actor.userId },
            data: { dataVersion: { increment: 1 } },
          })
        ).dataVersion
      : version;
    const result: ImportResult = {
      dataVersion: dataVersion.toString(),
      created,
      skipped,
      mappings,
      committedAt: now.toISOString(),
    };
    plan.status = 'committed';
    plan.disposition = 'committed';
    plan.canCommit = false;
    plan.result = result;
    await tx.importJob.update({
      where: { id: plan.id },
      data: {
        status: 'committed',
        plan: json(plan),
        receipt: json(result),
        completedAt: now,
      },
    });
    return plan;
  }
  async cancel(actor: Actor, id: string) {
    return this.db.$transaction(async (tx) => {
      await this.user(tx, actor);
      const { plan } = await this.lockedJob(tx, actor, id);
      if (plan.status === 'committed') throw conflict();
      plan.status = 'cancelled';
      plan.canCommit = false;
      await tx.importJob.update({
        where: { id },
        data: { status: 'cancelled', plan: json(plan), input: Prisma.DbNull },
      });
      return plan;
    });
  }
}
