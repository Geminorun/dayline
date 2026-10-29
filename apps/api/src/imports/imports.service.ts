import { msg } from '@dayline/locales';
import {
  categoryOrder,
  nextCategoryPosition,
} from '../records/category-order.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_CATEGORIES, businessToday } from '@dayline/core';
import {
  importJobSchema,
  importResultSchema,
  normalizedImportSourceSchema,
  importReceiptIndex,
  importSourceReceipt,
} from '@dayline/contracts';
import {
  initializeFilePlan,
  reassessFilePlan,
  reconcileFileCategories,
  reviewFileCategory,
  fileMappingsValid,
  updateFileCounts,
  applyFilePlan,
} from '@dayline/contracts/files';
import type {
  GuestAdmissionInput,
  NormalizedImportSource,
  ImportJobDto,
  ImportReviewInput,
  ImportCommitInput,
  ImportResult,
  CategoryDto,
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
  new AppError(409, code, msg('errors.theAccessBasisHasChangedPleaseCheck'));
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
      throw new AppError(
        401,
        'SESSION_REVOKED',
        msg('errors.pleaseLogInAgain'),
      );
    if (user.status !== 'active')
      throw new AppError(
        403,
        'ACCOUNT_PENDING_DELETION',
        msg('errors.accountDeletionIsPending2'),
      );
    if (!user.initializedAt)
      throw new AppError(
        503,
        'ACCOUNT_NOT_INITIALIZED',
        msg('errors.theAccountIsNotReadyYet'),
      );
    return user;
  }
  private async receiptOwners(tx: Tx, userId: string) {
    const sources = await tx.user.findMany({
      where: { status: 'merged', mergedIntoUserId: userId },
      select: { id: true },
    });
    return [userId, ...sources.map((s) => s.id)];
  }
  private async cloud(tx: Tx, userId: string) {
    const [categories, entries, focus] = await Promise.all([
      tx.category.findMany({ where: { userId }, orderBy: categoryOrder }),
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
    if (!row)
      throw new AppError(
        404,
        'RESOURCE_NOT_FOUND',
        msg('errors.theAccessTaskDoesNotExist'),
      );
    if (row.status !== 'committed' && row.authEpoch !== actor.authEpoch)
      throw conflict();
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
  private ready(plan: ImportJobDto, categories: CategoryDto[]) {
    const names = plan.categoryMappings
      .filter((c) => !c.targetId && c.action !== 'skip')
      .map((c) => c.name);
    plan.canCommit =
      plan.status === 'preview' &&
      !plan.categoryMappings.some(
        (c) => c.action !== 'skip' && c.needsReview,
      ) &&
      !plan.rows.some(
        (r) => r.action === 'needs_review' || r.file?.errors.length,
      ) &&
      categories.length + names.length <= 20 &&
      (plan.kind === 'guest' || fileMappingsValid(plan, categories)) &&
      new Set(names).size === names.length;
    if (plan.kind !== 'guest') updateFileCounts(plan);
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
      throw new AppError(
        422,
        'IMPORT_INVALID',
        msg('errors.invalidNormalizedImportSource'),
      );
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
        msg('errors.theLocalTimeOrTrashPeriodCannot'),
      );
    const inputDigest = source.file?.digest ?? hash({ kind, source });
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
    return this.db.transaction(
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
          where: {
            userId: { in: await this.receiptOwners(tx, actor.userId) },
            kind,
            status: 'committed',
          },
          orderBy: { completedAt: 'asc' },
          select: { receipt: true },
        });
        const processed = importReceiptIndex(
          previous.flatMap((job) => {
            const receipt = importResultSchema.safeParse(job.receipt);
            return receipt.success ? [receipt.data] : [];
          }),
        );
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
              const prior = importSourceReceipt(
                processed,
                sourceKey,
                sourceDigest,
              );
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
                processed: prior?.sourceDigest === sourceDigest,
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
        if (source.file)
          initializeFilePlan(plan, source, cloud, processed, now.toISOString());
        this.ready(plan, cloud.categories);
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
    return this.db.transaction(async (tx) => {
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
          msg('errors.theTaskHasNotBeenCreatedYet'),
        );
      return (await this.lockedJob(tx, actor, row?.id ?? id)).plan;
    });
  }
  async review(actor: Actor, id: string, input: ImportReviewInput) {
    return this.db.transaction(async (tx) => {
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
        throw new AppError(
          422,
          'IMPORT_INVALID',
          msg('errors.duplicatePreviewSelection'),
        );
      for (const choice of input.categories) {
        const mapping = plan.categoryMappings.find(
          (c) => c.sourceId === choice.sourceId,
        );
        if (!mapping) throw conflict();
        if (plan.kind !== 'guest') {
          try {
            reviewFileCategory(mapping, choice, cloud, plan.categoryMappings);
          } catch (error) {
            if (error instanceof Error && 'code' in error)
              throw new AppError(409, String(error.code), error.message);
            throw error;
          }
          continue;
        }
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
            msg('errors.pleaseDistinguishTheCategoryNameOrExplicitly'),
          );
        Object.assign(mapping, {
          targetId: choice.targetId,
          name: choice.name,
          color: choice.color,
          needsReview: false,
        });
      }
      if (plan.kind !== 'guest')
        reassessFilePlan(plan, cloud, this.clock.now().toISOString());
      const rowsByKey = new Map(plan.rows.map((r) => [r.sourceKey, r])),
        currentById = new Map(cloud.entries.map((e) => [e.id, e])),
        focusByEntry = new Map<string, typeof cloud.focusDays>();
      for (const f of cloud.focusDays) {
        const days = focusByEntry.get(f.entryId) ?? [];
        days.push(f);
        focusByEntry.set(f.entryId, days);
      }
      for (const choice of input.rows) {
        const row = rowsByKey.get(choice.sourceKey);
        if (!row) throw conflict();
        if (row.processed && choice.action !== 'skip')
          throw conflict('IMPORT_REVIEW_REQUIRED');
        if (
          row.source.purgeAfter &&
          Date.parse(row.source.purgeAfter) <= this.clock.now().getTime() &&
          choice.action !== 'skip'
        )
          throw new AppError(
            410,
            'TRASH_EXPIRED',
            msg('errors.expiredTrashCannotBeExtended'),
          );
        if (row.file?.errors.length)
          throw new AppError(
            422,
            'IMPORT_INVALID',
            msg('errors.pleaseCorrectTheErrorLineAndUpload'),
          );
        if (choice.action === 'apply_update' || choice.action === 'restore') {
          if (!row.file || plan.kind === 'guest') throw conflict();
          const current = currentById.get(row.file.requestedId ?? '');
          if (
            !current ||
            choice.expectedEntryVersion !== current.version ||
            choice.expectedFocusVersion !== current.focusVersion
          )
            throw conflict();
          if (
            choice.action === 'apply_update' &&
            (current.deletedAt || row.source.deletedAt)
          )
            throw conflict();
          if (
            choice.action === 'restore' &&
            (!current.deletedAt || row.source.deletedAt)
          )
            throw conflict();
          row.file.current = current;
          row.file.currentFocusDays = focusByEntry.get(current.id) ?? [];
          row.file.entryVersion = current.version;
          row.file.focusVersion = current.focusVersion;
          row.previousTargetId = current.id;
        }
        row.choice = choice.action;
        row.action =
          choice.action === 'apply_update' && !row.file?.differences.length
            ? 'unchanged'
            : choice.action;
      }
      if (plan.kind !== 'guest') reconcileFileCategories(plan, cloud);
      // Re-reading cloud is an explicit review boundary. Candidates remain stable.
      for (const mapping of plan.categoryMappings)
        if (
          mapping.targetId &&
          !mapping.restoreDefault &&
          mapping.action !== 'skip' &&
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
      this.ready(plan, cloud.categories);
      await tx.importJob.update({ where: { id }, data: { plan: json(plan) } });
      return plan;
    });
  }
  async commit(actor: Actor, id: string, input: ImportCommitInput) {
    return this.db.transaction(
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
    const history = await tx.importJob.findMany({
      where: {
        userId: { in: await this.receiptOwners(tx, actor.userId) },
        kind: plan.kind,
        status: 'committed',
      },
      select: { receipt: true },
    });
    const completed = importReceiptIndex(
      history.flatMap((job) => {
        const parsed = importResultSchema.safeParse(job.receipt);
        return parsed.success ? [parsed.data] : [];
      }),
    );
    if (
      plan.rows.some(
        (row) =>
          row.action === 'create_copy' &&
          completed.has(row.sourceKey + '@' + row.sourceDigest),
      ) ||
      plan.categoryMappings.some(
        (c) =>
          !c.targetId &&
          c.action !== 'skip' &&
          c.sourceKey &&
          c.sourceDigest &&
          completed.has(c.sourceKey + '@' + c.sourceDigest),
      )
    )
      throw conflict();
    if (plan.kind !== 'guest') return this.applyFile(tx, actor, plan, version);
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
            sortOrder: await nextCategoryPosition(tx, actor.userId),
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
        throw new AppError(
          422,
          'IMPORT_INVALID',
          msg('errors.categoryMapMissing'),
        );
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
      updated: 0,
      unchanged: 0,
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
  private async applyFile(
    tx: Tx,
    actor: Actor,
    plan: ImportJobDto,
    version: bigint,
  ) {
    const now = this.clock.now();
    const cloud = await this.cloud(tx, actor.userId);
    let applied: ReturnType<typeof applyFilePlan>;
    try {
      applied = applyFilePlan(cloud, plan, now.toISOString());
    } catch (error) {
      if (error instanceof Error && 'code' in error)
        throw new AppError(409, String(error.code), error.message);
      throw error;
    }
    const oldCategories = new Map(cloud.categories.map((c) => [c.id, c]));
    const changedCategories = applied.cloud.categories.filter(
      (c) =>
        oldCategories.has(c.id) &&
        JSON.stringify(oldCategories.get(c.id)) !== JSON.stringify(c),
    );
    const reservedNames = new Set(
      [...cloud.categories, ...applied.cloud.categories].map((c) => c.name),
    );
    for (const c of changedCategories) {
      let temporary: string;
      do {
        temporary = '~' + randomUUID().replaceAll('-', '').slice(0, 10);
      } while (reservedNames.has(temporary));
      reservedNames.add(temporary);
      await tx.category.update({
        where: { id: c.id },
        data: { name: temporary },
      });
    }
    for (const c of changedCategories)
      await tx.category.update({
        where: { id: c.id },
        data: {
          name: c.name,
          color: c.color,
          version: c.version,
          updatedAt: new Date(c.updatedAt),
        },
      });
    for (const c of applied.cloud.categories)
      if (!oldCategories.has(c.id))
        await tx.category.create({
          data: {
            id: c.id,
            userId: actor.userId,
            sortOrder: await nextCategoryPosition(tx, actor.userId),
            name: c.name,
            color: c.color,
            seedKey: c.seedKey,
          },
        });
    const oldEntries = new Map(cloud.entries.map((e) => [e.id, e]));
    const newEntries: Prisma.EntryCreateManyInput[] = [],
      updates: typeof cloud.entries = [];
    for (const e of applied.cloud.entries) {
      const old = oldEntries.get(e.id);
      const data = {
        categoryId: e.categoryId,
        title: e.title,
        startDate: databaseDate(e.startDate),
        endDate: e.endDate ? databaseDate(e.endDate) : null,
        version: e.version,
        focusVersion: e.focusVersion,
        deletedAt: e.deletedAt ? new Date(e.deletedAt) : null,
        purgeAfter: e.purgeAfter ? new Date(e.purgeAfter) : null,
        updatedAt: new Date(e.updatedAt),
      };
      if (!old) newEntries.push({ id: e.id, userId: actor.userId, ...data });
      else if (JSON.stringify(old) !== JSON.stringify(e)) updates.push(e);
    }
    for (let offset = 0; offset < newEntries.length; offset += 1000)
      await tx.entry.createMany({
        data: newEntries.slice(offset, offset + 1000),
      });
    for (let offset = 0; offset < updates.length; offset += 500) {
      const values = updates
        .slice(offset, offset + 500)
        .map(
          (e) =>
            Prisma.sql`(${e.id}::uuid,${e.categoryId}::uuid,${e.title}::text,${databaseDate(e.startDate)}::date,${e.endDate ? databaseDate(e.endDate) : null}::date,${e.version}::int,${e.focusVersion}::int,${e.deletedAt ? new Date(e.deletedAt) : null}::timestamptz,${e.purgeAfter ? new Date(e.purgeAfter) : null}::timestamptz,${new Date(e.updatedAt)}::timestamptz)`,
        );
      await tx.$executeRaw(
        Prisma.sql`UPDATE entries e SET category_id=v.category_id,title=v.title,start_date=v.start_date,end_date=v.end_date,version=v.version,focus_version=v.focus_version,deleted_at=v.deleted_at,purge_after=v.purge_after,updated_at=v.updated_at FROM (VALUES ${Prisma.join(values)}) AS v(id,category_id,title,start_date,end_date,version,focus_version,deleted_at,purge_after,updated_at) WHERE e.id=v.id AND e.user_id=${actor.userId}::uuid`,
      );
    }
    const changedFocusIds = new Set(
      updates
        .filter((e) => oldEntries.get(e.id)?.focusVersion !== e.focusVersion)
        .map((e) => e.id),
    );
    if (changedFocusIds.size)
      await tx.entryFocusDay.deleteMany({
        where: {
          entryId: { in: [...changedFocusIds] },
          entry: { userId: actor.userId },
        },
      });
    const newFocus = applied.cloud.focusDays
      .filter(
        (f) => !oldEntries.has(f.entryId) || changedFocusIds.has(f.entryId),
      )
      .map((f) => ({ ...f, date: databaseDate(f.date), updatedAt: now }));
    for (let offset = 0; offset < newFocus.length; offset += 1000)
      await tx.entryFocusDay.createMany({
        data: newFocus.slice(offset, offset + 1000),
      });
    const changed =
      newEntries.length ||
      applied.updated ||
      changedCategories.length ||
      oldCategories.size !== applied.cloud.categories.length;
    const dataVersion = changed
      ? (
          await tx.user.update({
            where: { id: actor.userId },
            data: { dataVersion: { increment: 1 } },
          })
        ).dataVersion
      : version;
    plan.result = {
      dataVersion: dataVersion.toString(),
      created: applied.created,
      updated: applied.updated,
      unchanged: applied.unchanged,
      skipped: applied.skipped,
      mappings: applied.mappings,
      categoryMappings: applied.categoryMappings,
      committedAt: now.toISOString(),
    };
    plan.status = 'committed';
    plan.disposition = 'committed';
    plan.canCommit = false;
    await tx.importJob.update({
      where: { id: plan.id },
      data: {
        status: 'committed',
        plan: json(plan),
        receipt: json(plan.result),
        completedAt: now,
      },
    });
    return plan;
  }
  async cancel(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
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
