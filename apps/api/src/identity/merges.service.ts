import { msg } from '@dayline/locales';
import {
  categoryOrder,
  nextCategoryPosition,
} from '../records/category-order.js';
import { Clock } from '../records/clock.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { mergePlanSchema } from '@dayline/contracts';
import type {
  MergePlan,
  MergeMappings,
  mergeReviewSchema,
  mergeCommitSchema,
} from '@dayline/contracts';
import type { z } from 'zod';

import { PrismaService } from '../database/prisma.service.js';
import type {
  Prisma,
  MergeContext,
  AccountMerge,
} from '../generated/prisma/client.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
import { ActionProofService } from '../auth/action-proof.service.js';
import { AuthAdapter } from '../auth/adapter/auth-adapter.js';
import { categoryDto, entryDto, focusDto } from '../records/record-dto.js';
import { identityJson } from './identity.service.js';
const stale = () =>
  new AppError(
    409,
    'PREVIEW_STALE',
    msg('errors.theMergingBasisHasChangedPleaseRe'),
  );
type Tx = Prisma.TransactionClient;
@Injectable()
export class MergesService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ActionProofService) private readonly proofs: ActionProofService,
    @Inject(AuthAdapter) private readonly auth: AuthAdapter,
  ) {}
  private transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout?: number } = {},
  ) {
    return this.db.transaction(work, {
      maxWait: 10000,
      timeout: 60000,
      ...options,
    });
  }

  private async lock(tx: Tx, ids: string[]) {
    for (const id of [...new Set(ids)].sort())
      await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`;
  }
  private async context(
    tx: Tx,
    actor: Actor,
    id: string,
    operationId?: string,
  ) {
    await this.proofs.current(tx, actor);
    const row = await tx.mergeContext.findFirst({
      where: {
        id,
        initiatorUserId: actor.userId,
        sessionId: actor.sessionId,
        ...(operationId ? { operationId } : {}),
      },
    });
    if (!row || row.expiresAt <= this.clock.now())
      throw new AppError(
        403,
        'REAUTH_REQUIRED',
        msg('errors.pleaseReVerifyTheIdentitiesOfBoth'),
      );
    const [a, b] = await Promise.all([
      tx.user.findUnique({ where: { id: row.initiatorUserId } }),
      tx.user.findUnique({ where: { id: row.otherUserId } }),
    ]);
    if (
      !a ||
      !b ||
      a.status !== 'active' ||
      b.status !== 'active' ||
      a.authEpoch !== row.initiatorEpoch ||
      b.authEpoch !== row.otherEpoch
    )
      throw stale();
    if (!a.initializedAt || !b.initializedAt)
      throw new AppError(
        503,
        'ACCOUNT_NOT_INITIALIZED',
        msg('errors.theAccountBusinessStructureIsNotReady'),
      );
    return { row, a, b };
  }
  private async combination(tx: Tx, context: MergeContext) {
    const users = await tx.user.findMany({
      where: { id: { in: [context.initiatorUserId, context.otherUserId] } },
      include: { accounts: true, wechatIdentities: true },
    });
    if (
      users.length !== 2 ||
      users.filter((u) => u.emailKind === 'real').length > 1 ||
      users.flatMap((u) => u.wechatIdentities).length > 1 ||
      users
        .flatMap((u) => u.accounts)
        .some((a) => a.providerId !== 'credential') ||
      users
        .flatMap((u) => u.accounts)
        .filter((a) => a.providerId === 'credential').length > 1
    )
      throw new AppError(
        409,
        'IDENTITY_COMBINATION_UNSUPPORTED',
        msg('errors.theFirstVersionOnlySupportsOneReal'),
      );
  }
  private async cloud(tx: Tx, userId: string) {
    const [categories, entries, focusDays] = await Promise.all([
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
      focusDays: focusDays.map(focusDto),
    };
  }
  private ready(plan: MergePlan) {
    const names = plan.categoryMappings
      .filter((m) => !m.targetId)
      .map((m) => m.name);
    plan.conflicts = [];
    if (plan.categoryMappings.some((m) => m.needsReview))
      plan.conflicts.push('同名异色分类需要明确改名或映射。');
    if (plan.targetCategories.length + names.length > 20)
      plan.conflicts.push('合并后超过 20 个分类，请明确映射或先整理账号。');
    if (
      new Set([...plan.targetCategories.map((c) => c.name), ...names]).size !==
      plan.targetCategories.length + names.length
    )
      plan.conflicts.push('分类名称重复，请区分名称。');
    plan.counts = {
      retained: plan.entries.length + plan.targetEntries.length,
      reusedCategories: plan.categoryMappings.filter((m) => m.targetId).length,
      newCategories: names.length,
    };
    plan.canCommit = plan.status === 'preview' && plan.conflicts.length === 0;
    plan.planDigest =
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify({ ...plan, planDigest: '' }))
        .digest('hex');
  }
  async preview(actor: Actor, contextId: string, operationId: string) {
    return this.transaction(
      async (tx) => {
        const initial = await tx.mergeContext.findFirst({
          where: { id: contextId, initiatorUserId: actor.userId },
        });
        if (!initial)
          throw new AppError(
            404,
            'RESOURCE_NOT_FOUND',
            msg('errors.authenticatedMergeContextDoesNotExist'),
          );
        await this.lock(tx, [initial.initiatorUserId, initial.otherUserId]);
        const { row, a, b } = await this.context(
          tx,
          actor,
          contextId,
          operationId,
        );
        await this.combination(tx, row);
        const old = await tx.accountMerge.findUnique({
          where: {
            initiatorUserId_operationId: {
              initiatorUserId: actor.userId,
              operationId,
            },
          },
        });
        if (old) {
          if (old.sourceUserId !== b.id || old.targetUserId !== a.id)
            throw new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              msg('errors.thisOperationHasBeenBoundToAnother'),
            );
          const plan = mergePlanSchema.parse(old.plan);
          if (old.status !== 'preview') return plan;
          const originalContext = await tx.mergeContext.findUnique({
            where: { id: old.contextId },
          });
          if (!originalContext || originalContext.sessionId !== actor.sessionId)
            throw new AppError(
              403,
              'REAUTH_REQUIRED',
              msg('errors.pleaseContinueInTheOriginalMergeSession'),
            );
          if (
            old.sourceDataVersion !== b.dataVersion ||
            old.targetDataVersion !== a.dataVersion ||
            old.sourceEpoch !== b.authEpoch ||
            old.targetEpoch !== a.authEpoch ||
            old.expiresAt <= this.clock.now()
          )
            throw stale();
          await tx.accountMerge.update({
            where: { id: old.id },
            data: { contextId },
          });
          return plan;
        }
        const [source, target] = await Promise.all([
          this.cloud(tx, b.id),
          this.cloud(tx, a.id),
        ]);
        const summary = (user: typeof a, cloud: typeof source) => ({
          userId: user.id,
          displayName: user.name,
          email: user.emailKind === 'real' ? user.email : null,
          entries: cloud.entries.filter((e) => !e.deletedAt).length,
          trash: cloud.entries.filter((e) => e.deletedAt).length,
          categories: cloud.categories.length,
          focusDays: cloud.focusDays.length,
        });
        const reservedNames = new Set(target.categories.map((c) => c.name));
        const proposed = source.categories.map((c) => {
          const same = target.categories.find(
            (t) => t.name === c.name && t.color === c.color,
          );
          let name = c.name;
          if (!same && reservedNames.has(name)) {
            let suffix = 2;
            do {
              const ending = `（${suffix++}）`;
              name =
                [...c.name].slice(0, 12 - [...ending].length).join('') + ending;
            } while (reservedNames.has(name));
          }
          reservedNames.add(name);
          return {
            sourceId: c.id,
            sourceName: c.name,
            sourceColor: c.color,
            targetId: same?.id ?? null,
            name,
            color: c.color,
            needsReview: name !== c.name,
          };
        });
        const plan: MergePlan = {
          id: randomUUID(),
          operationId,
          status: 'preview',
          planRevision: 1,
          planDigest: '',
          expiresAt: new Date(
            this.clock.now().getTime() + 900_000,
          ).toISOString(),
          sourceSummary: summary(b, source),
          targetSummary: summary(a, target),
          sourceDataVersion: b.dataVersion.toString(),
          targetDataVersion: a.dataVersion.toString(),
          targetCategories: target.categories,
          categoryMappings: proposed,
          entries: source.entries,
          targetEntries: target.entries,
          targetFocusDays: target.focusDays,
          focusDays: source.focusDays,
          canCommit: false,
          conflicts: [],
          counts: { retained: 0, reusedCategories: 0, newCategories: 0 },
          displayNameFrom: 'target',
          result: null,
        };
        this.ready(plan);
        await tx.accountMerge.create({
          data: {
            id: plan.id,
            initiatorUserId: actor.userId,
            sourceUserId: b.id,
            targetUserId: a.id,
            operationId,
            contextId,
            sourceEpoch: b.authEpoch,
            targetEpoch: a.authEpoch,
            sourceDataVersion: b.dataVersion,
            targetDataVersion: a.dataVersion,
            plan: identityJson(plan),
            expiresAt: new Date(plan.expiresAt),
          },
        });
        return plan;
      },
      { timeout: 60_000 },
    );
  }
  private async job(tx: Tx, actor: Actor, id: string) {
    const row = await tx.accountMerge.findFirst({
      where: { id, targetUserId: actor.userId },
    });
    if (!row)
      throw new AppError(
        404,
        'RESOURCE_NOT_FOUND',
        msg('errors.theMergeTaskDoesNotExist'),
      );
    await this.lock(tx, [row.sourceUserId, row.targetUserId]);
    await this.proofs.current(tx, actor);
    await tx.$queryRaw`SELECT id FROM account_merges WHERE id=${id}::uuid FOR UPDATE`;
    const locked = await tx.accountMerge.findUniqueOrThrow({ where: { id } });
    const plan = mergePlanSchema.parse(locked.plan);
    if (locked.status === 'committed') return { row: locked, plan };
    const { a, b } = await this.context(
      tx,
      actor,
      locked.contextId,
      locked.operationId,
    );
    if (
      locked.sourceEpoch !== b.authEpoch ||
      locked.targetEpoch !== a.authEpoch
    )
      throw stale();
    if (locked.expiresAt <= this.clock.now()) {
      plan.status = 'expired';
      plan.canCommit = false;
    }
    return { row: locked, plan };
  }
  async get(actor: Actor, id: string) {
    return this.transaction(async (tx) => (await this.job(tx, actor, id)).plan);
  }
  async list(actor: Actor) {
    // Minimal authorized handles only; no source snapshots or proofs in a recovery list.
    return this.transaction(async (tx) => {
      await this.proofs.current(tx, actor);
      return tx.accountMerge.findMany({
        where: { targetUserId: actor.userId },
        select: {
          id: true,
          operationId: true,
          status: true,
          sourceUserId: true,
          targetUserId: true,
          createdAt: true,
          completedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  }
  private async unchanged(tx: Tx, row: AccountMerge) {
    const users = await tx.user.findMany({
      where: { id: { in: [row.sourceUserId, row.targetUserId] } },
    });
    const plan = mergePlanSchema.parse(row.plan);
    if (
      users.find((u) => u.id === row.sourceUserId)?.name !==
        plan.sourceSummary.displayName ||
      users.find((u) => u.id === row.targetUserId)?.name !==
        plan.targetSummary.displayName
    )
      throw stale();
    if (
      users.find((u) => u.id === row.sourceUserId)?.dataVersion !==
        row.sourceDataVersion ||
      users.find((u) => u.id === row.targetUserId)?.dataVersion !==
        row.targetDataVersion
    )
      throw stale();
  }
  async review(
    actor: Actor,
    id: string,
    input: z.infer<typeof mergeReviewSchema>,
  ) {
    return this.transaction(async (tx) => {
      const { row, plan } = await this.job(tx, actor, id);
      if (
        plan.status !== 'preview' ||
        plan.planRevision !== input.expectedPlanRevision
      )
        throw stale();
      await this.unchanged(tx, row);
      if (
        new Set(input.categories.map((c) => c.sourceId)).size !==
        input.categories.length
      )
        throw stale();
      for (const choice of input.categories) {
        const mapping = plan.categoryMappings.find(
          (m) => m.sourceId === choice.sourceId,
        );
        if (!mapping) throw stale();
        const target = plan.targetCategories.find(
          (c) => c.id === choice.targetId,
        );
        if (
          choice.targetId &&
          (!target ||
            target.name !== choice.name ||
            target.color !== choice.color)
        )
          throw stale();
        Object.assign(mapping, choice, { needsReview: false });
      }
      plan.displayNameFrom = input.displayNameFrom;
      plan.planRevision++;
      this.ready(plan);
      await tx.accountMerge.update({
        where: { id },
        data: { plan: identityJson(plan) },
      });
      return plan;
    });
  }
  async cancel(actor: Actor, id: string) {
    return this.transaction(async (tx) => {
      // Cancellation remains possible after a proof expired; no source private content is returned.
      const row = await tx.accountMerge.findFirst({
        where: { id, targetUserId: actor.userId },
      });
      if (!row)
        throw new AppError(
          404,
          'RESOURCE_NOT_FOUND',
          msg('errors.theMergeTaskDoesNotExist'),
        );
      await this.lock(tx, [row.sourceUserId, row.targetUserId]);
      await this.proofs.current(tx, actor);
      const changed = await tx.accountMerge.updateMany({
        where: { id, status: { in: ['preview', 'cancelled', 'expired'] } },
        data: { status: 'cancelled' },
      });
      if (!changed.count) throw stale();
      const plan = mergePlanSchema.parse(row.plan);
      plan.status = 'cancelled';
      plan.canCommit = false;
      await tx.accountMerge.update({
        where: { id },
        data: { plan: identityJson(plan) },
      });
      return { success: true as const };
    });
  }
  async commit(
    actor: Actor,
    id: string,
    input: z.infer<typeof mergeCommitSchema>,
  ) {
    return this.transaction(
      async (tx) => {
        const { row, plan } = await this.job(tx, actor, id);
        if (plan.status === 'committed') return plan;
        if (
          plan.status !== 'preview' ||
          !plan.canCommit ||
          plan.planRevision !== input.expectedPlanRevision ||
          plan.planDigest !== input.planDigest
        )
          throw stale();
        await this.unchanged(tx, row);
        const { row: context } = await this.context(
          tx,
          actor,
          row.contextId,
          row.operationId,
        );
        await this.combination(tx, context);
        const [source, target] = await Promise.all([
          this.cloud(tx, row.sourceUserId),
          this.cloud(tx, row.targetUserId),
        ]);
        const categoryIds = new Map<string, string>();
        for (const mapping of plan.categoryMappings) {
          const targetId = mapping.targetId ?? randomUUID();
          categoryIds.set(mapping.sourceId, targetId);
          if (!mapping.targetId)
            await tx.category.create({
              data: {
                id: targetId,
                userId: row.targetUserId,
                sortOrder: await nextCategoryPosition(tx, row.targetUserId),
                name: mapping.name,
                color: mapping.color,
                seedKey: null,
              },
            });
          // IDs and both content/focus versions stay stable; the draft must still compare its original base.
          await tx.entry.updateMany({
            where: { userId: row.sourceUserId, categoryId: mapping.sourceId },
            data: { userId: row.targetUserId, categoryId: targetId },
          });
        }
        await tx.category.deleteMany({ where: { userId: row.sourceUserId } });
        const emailEvidence = await tx.emailBindingRequest.findFirst({
          where: {
            userId: row.initiatorUserId,
            operationId: row.operationId,
            authEpoch: actor.authEpoch,
            status: 'verified',
            expiresAt: { gt: this.clock.now() },
          },
        });
        await this.auth.migrateCredentials(
          tx,
          row.sourceUserId,
          row.targetUserId,
          emailEvidence?.email,
        );
        await tx.user.update({
          where: { id: row.sourceUserId },
          data: {
            status: 'merged',
            mergedIntoUserId: row.targetUserId,
            authEpoch: { increment: 1 },
          },
        });
        // An earlier merge's authorized source shells and minimal receipts now belong to the final target.
        await tx.user.updateMany({
          where: { status: 'merged', mergedIntoUserId: row.sourceUserId },
          data: { mergedIntoUserId: row.targetUserId },
        });
        const user = await tx.user.update({
          where: { id: row.targetUserId },
          data: {
            authEpoch: { increment: 1 },
            dataVersion: { increment: 1 },
            ...(plan.displayNameFrom === 'source'
              ? {
                  name: plan.sourceSummary.displayName,
                  profileVersion: { increment: 1 },
                }
              : {}),
          },
        });
        await tx.session.deleteMany({
          where: { userId: { in: [row.sourceUserId, row.targetUserId] } },
        });
        const mappings: MergeMappings = {
          mergeId: id,
          sourceUserId: row.sourceUserId,
          targetUserId: row.targetUserId,
          entries: source.entries.map((e) => ({ oldId: e.id, newId: e.id })),
          categories: [...categoryIds].map(([oldId, newId]) => ({
            oldId,
            newId,
          })),
        };
        plan.status = 'committed';
        plan.canCommit = false;
        plan.result = {
          targetUserId: row.targetUserId,
          sourceUserId: row.sourceUserId,
          dataVersion: user.dataVersion.toString(),
          committedAt: this.clock.now().toISOString(),
          reauthenticate: true,
        };
        await tx.accountMerge.update({
          where: { id },
          data: {
            status: 'committed',
            plan: identityJson(plan),
            recoverySnapshot: identityJson({ source, target, mappings }),
            recoveryExpiresAt: new Date(
              this.clock.now().getTime() + 7 * 86400000,
            ),
            completedAt: this.clock.now(),
          },
        });
        // Mappings must outlive the private recovery snapshot. Keep them in a separate minimal field.
        await tx.mergeRecordMapping.create({
          data: { mergeId: id, mappings: identityJson(mappings) },
        });
        return plan;
      },
      { timeout: 60_000 },
    );
  }
  async mappings(actor: Actor, id: string, proof: string, operationId: string) {
    await this.proofs.verify(proof, actor, {
      purpose: 'recover_drafts',
      operationId,
      target: id,
    });
    return this.transaction(async (tx) => {
      await this.proofs.current(tx, actor);
      const row = await tx.accountMerge.findFirst({
        where: { id, status: 'committed' },
      });
      if (!row)
        throw new AppError(
          404,
          'RESOURCE_NOT_FOUND',
          msg('errors.authorizationMappingDoesNotExist'),
        );
      const source = await tx.user.findFirst({
        where: {
          id: row.sourceUserId,
          status: 'merged',
          mergedIntoUserId: actor.userId,
        },
      });
      if (!source)
        throw new AppError(
          404,
          'RESOURCE_NOT_FOUND',
          msg('errors.authorizationMappingDoesNotExist'),
        );
      const mapping = await tx.mergeRecordMapping.findUniqueOrThrow({
        where: { mergeId: id },
      });
      const data = await import('@dayline/contracts').then((c) =>
        c.mergeMappingsSchema.parse(mapping.mappings),
      );
      return { ...data, targetUserId: actor.userId };
    });
  }
}
