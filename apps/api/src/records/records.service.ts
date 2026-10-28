import { Inject, Injectable } from '@nestjs/common';
import { businessToday, nextCategoryColor } from '@dayline/core';
import type {
  CreateCategoryInput,
  ReorderCategoriesInput,
  PatchCategoryInput,
  DeleteCategoryInput,
  DeleteCategoryResult,
  CreateEntryInput,
  PatchEntryInput,
  SetFocusInput,
  PurgeTrashInput,
  FocusDayDto,
  EntryDto,
} from '@dayline/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Entry } from '../generated/prisma/client.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
import { Clock } from './clock.js';
import { categoryOrder, nextCategoryPosition } from './category-order.js';
import {
  calendarDate,
  databaseDate,
  categoryDto,
  entryDto,
  focusDto,
} from './record-dto.js';
type Transaction = Prisma.TransactionClient;
const notFound = () => new AppError(404, 'RESOURCE_NOT_FOUND', '记录不存在。');
function checkVersion(expectedVersion: number, currentVersion: number) {
  if (expectedVersion !== currentVersion)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      '记录已有更新，请核对后再次保存。',
      { expectedVersion, currentVersion },
    );
}
@Injectable()
export class RecordsService {
  constructor(
    @Inject(PrismaService) private readonly database: PrismaService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}
  private async readyUser(tx: Transaction, userId: string) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(401, 'SESSION_REVOKED', '登录状态已失效。');
    if (!user.initializedAt)
      throw new AppError(
        503,
        'ACCOUNT_NOT_INITIALIZED',
        '账号业务数据尚未初始化，请稍后重试。',
      );
    return user;
  }
  private async write<T>(
    actor: Actor,
    action: (tx: Transaction) => Promise<{ data: T; changed: boolean }>,
  ) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.userId}::uuid FOR UPDATE`;
        const user = await this.readyUser(tx, actor.userId);
        if (
          !user ||
          user.status === 'merged' ||
          user.authEpoch !== actor.authEpoch
        )
          throw new AppError(401, 'SESSION_REVOKED', '登录状态已失效。');
        if (user.status !== 'active')
          throw new AppError(
            403,
            'ACCOUNT_PENDING_DELETION',
            '账号正在注销中。',
          );
        const result = await action(tx);
        const version = result.changed
          ? (
              await tx.user.update({
                where: { id: user.id },
                data: { dataVersion: { increment: 1 } },
              })
            ).dataVersion
          : user.dataVersion;
        return { data: result.data, dataVersion: version.toString() };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          '分类名称或记录 ID 已被使用。',
        );
      throw error;
    }
  }
  private async category(tx: Transaction, userId: string, id: string) {
    const category = await tx.category.findFirst({ where: { id, userId } });
    if (!category) throw notFound();
    return category;
  }
  private async entry(
    tx: Transaction,
    userId: string,
    id: string,
    active = false,
  ) {
    const entry = await tx.entry.findFirst({ where: { id, userId } });
    if (!entry) throw notFound();
    if (active && entry.deletedAt)
      throw new AppError(409, 'ENTRY_DELETED', '事项已在回收站。');
    return entry;
  }
  private async entryResult(tx: Transaction, entry: Entry) {
    const focusDays = await tx.entryFocusDay.findMany({
      where: { entryId: entry.id },
      orderBy: { date: 'asc' },
    });
    return { entry: entryDto(entry), focusDays: focusDays.map(focusDto) };
  }
  categories(userId: string) {
    return this.database.transaction(
      async (tx) => {
        await this.readyUser(tx, userId);
        const values = await tx.category.findMany({
          where: { userId },
          orderBy: categoryOrder,
        });
        return values.map(categoryDto);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  createCategory(actor: Actor, input: CreateCategoryInput) {
    return this.write(actor, async (tx) => {
      const existing = await tx.category.findUnique({
        where: { id: input.id },
      });
      if (existing) {
        if (existing.userId !== actor.userId)
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '记录 ID 不可用。');
        if (existing.name !== input.name || existing.color !== input.color)
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            '此 ID 已保存不同内容。',
          );
        return {
          data: { category: categoryDto(existing), alreadyExists: true },
          changed: false,
        };
      }
      if ((await tx.category.count({ where: { userId: actor.userId } })) >= 20)
        throw new AppError(
          422,
          'CATEGORY_LIMIT_EXCEEDED',
          '最多保留 20 个分类。',
        );
      if (
        await tx.category.findUnique({
          where: { userId_name: { userId: actor.userId, name: input.name } },
        })
      )
        throw new AppError(409, 'CATEGORY_NAME_EXISTS', '分类名称已存在。');
      const category = await tx.category.create({
        data: {
          ...input,
          userId: actor.userId,
          sortOrder: await nextCategoryPosition(tx, actor.userId),
        },
      });
      return {
        data: { category: categoryDto(category), alreadyExists: false },
        changed: true,
      };
    });
  }
  patchCategory(actor: Actor, id: string, input: PatchCategoryInput) {
    return this.write(actor, async (tx) => {
      const category = await this.category(tx, actor.userId, id);
      checkVersion(input.expectedVersion, category.version);
      if (
        input.name !== undefined &&
        input.name !== category.name &&
        (await tx.category.findUnique({
          where: { userId_name: { userId: actor.userId, name: input.name } },
        }))
      )
        throw new AppError(409, 'CATEGORY_NAME_EXISTS', '分类名称已存在。');
      const changed =
        (input.name !== undefined && input.name !== category.name) ||
        (input.color !== undefined && input.color !== category.color);
      const updated = changed
        ? await tx.category.update({
            where: { id },
            data: {
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.color === undefined ? {} : { color: input.color }),
              version: { increment: 1 },
            },
          })
        : category;
      return { data: { category: categoryDto(updated) }, changed };
    });
  }
  reorderCategories(actor: Actor, input: ReorderCategoriesInput) {
    return this.write(actor, async (tx) => {
      const user = await this.readyUser(tx, actor.userId);
      if (user.dataVersion.toString() !== input.expectedDataVersion)
        throw new AppError(
          409,
          'DATA_VERSION_CONFLICT',
          '分类已有变化，请刷新后重新排序。',
        );
      const current = await tx.category.findMany({
        where: { userId: actor.userId },
        orderBy: categoryOrder,
      });
      const byId = new Map(current.map((c) => [c.id, c]));
      if (
        input.categoryIds.length !== current.length ||
        input.categoryIds.some((id) => !byId.has(id))
      )
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '请提交当前账号的全部分类。',
        );
      const changed = input.categoryIds.some(
        (id, index) => current[index]?.id !== id,
      );
      if (changed)
        for (const [index, id] of input.categoryIds.entries()) {
          const category = byId.get(id);
          if (!category) throw notFound();
          // Position is presentation metadata. Keep independent content versions stable.
          await tx.category.update({
            where: { id },
            data: { sortOrder: index, updatedAt: category.updatedAt },
          });
        }
      return {
        data: {
          categories: input.categoryIds.map((id) => {
            const category = byId.get(id);
            if (!category) throw notFound();
            return categoryDto(category);
          }),
        },
        changed,
      };
    });
  }
  deleteCategory(actor: Actor, id: string, input: DeleteCategoryInput) {
    return this.write<DeleteCategoryResult>(actor, async (tx) => {
      const source = await this.category(tx, actor.userId, id);
      if ((await tx.category.count({ where: { userId: actor.userId } })) <= 1)
        throw new AppError(409, 'LAST_CATEGORY', '至少保留一个分类。');
      if ('mode' in input) {
        const currentUser = await this.readyUser(tx, actor.userId);
        if (input.expectedDataVersion !== currentUser.dataVersion.toString())
          throw new AppError(
            409,
            'DATA_VERSION_CONFLICT',
            '记录已有变化，请重新确认删除。',
          );
        checkVersion(input.expectedVersion, source.version);
        const entries = await tx.entry.findMany({
          where: { userId: actor.userId, categoryId: id },
          select: { id: true, deletedAt: true },
        });
        const now = this.clock.now();
        let target = await tx.category.findFirst({
          where: { userId: actor.userId, name: '其他', NOT: { id } },
        });
        if (entries.length && !target) {
          if (
            await tx.category.findUnique({
              where: { id: input.fallbackCategoryId },
            })
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '备用分类标识已被使用。',
            );
          const categories = await tx.category.findMany({
            where: { userId: actor.userId },
          });
          if (source.name === '其他') {
            // Free the name within this transaction before redirecting foreign keys.
            const names = new Set(categories.map((c) => c.name));
            let suffix = 1;
            while (names.has(`归档分类${suffix}`)) suffix++;
            await tx.category.update({
              where: { id },
              data: { name: `归档分类${suffix}` },
            });
          }
          target = await tx.category.create({
            data: {
              id: input.fallbackCategoryId,
              userId: actor.userId,
              name: '其他',
              seedKey: null,
              color: nextCategoryColor(
                categories.filter((c) => c.id !== id).map((c) => c.color),
              ),
              sortOrder: await nextCategoryPosition(tx, actor.userId),
            },
          });
        }
        if (target) {
          // Existing trash keeps its original continuous deadline.
          await tx.entry.updateMany({
            where: {
              userId: actor.userId,
              categoryId: id,
              deletedAt: { not: null },
            },
            data: { categoryId: target.id, version: { increment: 1 } },
          });
          await tx.entry.updateMany({
            where: { userId: actor.userId, categoryId: id, deletedAt: null },
            data: {
              categoryId: target.id,
              deletedAt: now,
              purgeAfter: new Date(now.getTime() + 30 * 86400000),
              version: { increment: 1 },
            },
          });
        }
        await tx.category.delete({ where: { id } });
        return {
          data: {
            success: true as const,
            transferredCount: entries.length,
            trashedCount: entries.filter((e) => !e.deletedAt).length,
          },
          changed: true,
        };
      }
      const target = await this.category(
        tx,
        actor.userId,
        input.transferToCategoryId,
      );
      checkVersion(input.expectedVersion, source.version);
      checkVersion(input.expectedTargetVersion, target.version);
      if (source.id === target.id)
        throw new AppError(422, 'VALIDATION_ERROR', '请选择另一个分类。');
      const moved = await tx.entry.updateMany({
        where: { userId: actor.userId, categoryId: id },
        data: { categoryId: target.id, version: { increment: 1 } },
      });
      await tx.category.delete({ where: { id } });
      return {
        data: { success: true as const, transferredCount: moved.count },
        changed: true,
      };
    });
  }
  createEntry(actor: Actor, input: CreateEntryInput) {
    return this.write(actor, async (tx) => {
      const existing = await tx.entry.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.userId !== actor.userId)
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '记录 ID 不可用。');
        if (existing.deletedAt)
          throw new AppError(
            409,
            'ENTRY_DELETED',
            '事项已在回收站，请使用恢复操作。',
          );
        const current = entryDto(existing);
        if (
          current.title !== input.title ||
          current.categoryId !== input.categoryId ||
          current.startDate !== input.startDate ||
          current.endDate !== input.endDate
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            '此 ID 已保存不同内容。',
          );
        return {
          data: {
            ...(await this.entryResult(tx, existing)),
            alreadyExists: true,
          },
          changed: false,
        };
      }
      await this.category(tx, actor.userId, input.categoryId);
      this.validateRange(input.startDate, input.endDate);
      const entry = await tx.entry.create({
        data: {
          ...input,
          userId: actor.userId,
          startDate: databaseDate(input.startDate),
          endDate: input.endDate ? databaseDate(input.endDate) : null,
        },
      });
      return {
        data: { ...(await this.entryResult(tx, entry)), alreadyExists: false },
        changed: true,
      };
    });
  }
  private validateRange(start: string, end: string | null) {
    if (end !== null && end < start)
      throw new AppError(422, 'VALIDATION_ERROR', '结束日期不能早于开始日期。');
  }
  readEntry(userId: string, id: string) {
    return this.database.transaction(
      async (tx) => {
        await this.readyUser(tx, userId);
        return this.entryResult(tx, await this.entry(tx, userId, id));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  patchEntry(actor: Actor, id: string, input: PatchEntryInput) {
    return this.write(actor, async (tx) => {
      const current = await this.entry(tx, actor.userId, id, true);
      checkVersion(input.expectedVersion, current.version);
      if (input.categoryId !== undefined)
        await this.category(tx, actor.userId, input.categoryId);
      const start = input.startDate ?? calendarDate(current.startDate);
      const end =
        input.endDate === undefined
          ? current.endDate
            ? calendarDate(current.endDate)
            : null
          : input.endDate;
      this.validateRange(start, end);
      const affected = await tx.entryFocusDay.findMany({
        where: {
          entryId: id,
          focused: true,
          OR: [
            { date: { lt: databaseDate(start) } },
            ...(end ? [{ date: { gt: databaseDate(end) } }] : []),
          ],
        },
        orderBy: { date: 'asc' },
      });
      const list = affected.map((value) => ({
        date: calendarDate(value.date),
        version: value.version,
      }));
      if (list.length || input.focusRemovalAcknowledgement !== undefined) {
        const acknowledgement = input.focusRemovalAcknowledgement;
        const exact =
          acknowledgement &&
          acknowledgement.length === list.length &&
          [...acknowledgement]
            .sort((a, b) => a.date.localeCompare(b.date))
            .every(
              (value, index) =>
                value.date === list[index]?.date &&
                value.version === list[index]?.version,
            );
        if (!exact)
          throw new AppError(
            409,
            'FOCUS_REMOVAL_CONFIRMATION_REQUIRED',
            '日期范围变化将移除重点，请确认具体日期。',
            { currentVersion: current.version, affectedFocusDays: list },
          );
      }
      const changed =
        (input.title !== undefined && input.title !== current.title) ||
        (input.categoryId !== undefined &&
          input.categoryId !== current.categoryId) ||
        start !== calendarDate(current.startDate) ||
        end !== (current.endDate ? calendarDate(current.endDate) : null);
      if (!changed)
        return { data: await this.entryResult(tx, current), changed: false };
      if (affected.length)
        await tx.entryFocusDay.updateMany({
          where: {
            entryId: id,
            date: { in: affected.map((value) => value.date) },
          },
          data: { focused: false, version: { increment: 1 } },
        });
      const updated = await tx.entry.update({
        where: { id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.categoryId === undefined
            ? {}
            : { categoryId: input.categoryId }),
          startDate: databaseDate(start),
          endDate: end ? databaseDate(end) : null,
          version: { increment: 1 },
          ...(affected.length ? { focusVersion: { increment: 1 } } : {}),
        },
      });
      return { data: await this.entryResult(tx, updated), changed: true };
    });
  }
  finish(actor: Actor, id: string, expectedVersion: number) {
    return this.write(actor, async (tx) => {
      const entry = await this.entry(tx, actor.userId, id, true);
      checkVersion(expectedVersion, entry.version);
      const today = businessToday(this.clock.now());
      if (calendarDate(entry.startDate) > today)
        throw new AppError(422, 'VALIDATION_ERROR', '未来事项尚未开始。');
      if (entry.endDate && calendarDate(entry.endDate) < today)
        throw new AppError(
          409,
          'ENTRY_ALREADY_ENDED',
          '事项已在历史日期结束。',
        );
      const changed = !entry.endDate || calendarDate(entry.endDate) !== today;
      const updated = changed
        ? await tx.entry.update({
            where: { id },
            data: { endDate: databaseDate(today), version: { increment: 1 } },
          })
        : entry;
      return { data: await this.entryResult(tx, updated), changed };
    });
  }
  setFocus(actor: Actor, id: string, date: string, input: SetFocusInput) {
    return this.write(actor, async (tx) => {
      const entry = await this.entry(tx, actor.userId, id, true);
      checkVersion(input.expectedEntryVersion, entry.version);
      const current = await tx.entryFocusDay.findUnique({
        where: { entryId_date: { entryId: id, date: databaseDate(date) } },
      });
      if (input.expectedFocusVersion !== (current?.version ?? 0))
        throw new AppError(
          409,
          'FOCUS_VERSION_CONFLICT',
          '当天重点已有更新。',
          {
            entryId: id,
            date,
            expectedVersion: input.expectedFocusVersion,
            currentVersion: current?.version ?? 0,
            current: current
              ? focusDto(current)
              : { entryId: id, date, focused: false, version: 0 },
          },
        );
      if (
        input.focused &&
        (date > businessToday(this.clock.now()) ||
          date < calendarDate(entry.startDate) ||
          (entry.endDate && date > calendarDate(entry.endDate)))
      )
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '重点须在事项区间内且不晚于今天。',
        );
      if (input.focused === (current?.focused ?? false))
        return {
          data: {
            focusDay: current
              ? focusDto(current)
              : { entryId: id, date, focused: false, version: 0 },
            focusVersion: entry.focusVersion,
          },
          changed: false,
        };
      const focus = await tx.entryFocusDay.upsert({
        where: { entryId_date: { entryId: id, date: databaseDate(date) } },
        create: {
          entryId: id,
          date: databaseDate(date),
          focused: input.focused,
        },
        update: { focused: input.focused, version: { increment: 1 } },
      });
      const updated = await tx.entry.update({
        where: { id },
        data: { focusVersion: { increment: 1 } },
      });
      return {
        data: { focusDay: focusDto(focus), focusVersion: updated.focusVersion },
        changed: true,
      };
    });
  }
  deleteEntry(actor: Actor, id: string, expectedVersion: number) {
    return this.write(actor, async (tx) => {
      const entry = await this.entry(tx, actor.userId, id, true);
      checkVersion(expectedVersion, entry.version);
      const now = this.clock.now();
      const updated = await tx.entry.update({
        where: { id },
        data: {
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + 30 * 86400000),
          version: { increment: 1 },
        },
      });
      return { data: await this.entryResult(tx, updated), changed: true };
    });
  }
  trash(userId: string) {
    return this.database.transaction(
      async (tx) => {
        await this.readyUser(tx, userId);
        const values = await tx.entry.findMany({
          where: {
            userId,
            deletedAt: { not: null },
            purgeAfter: { gt: this.clock.now() },
          },
          orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
        });
        return values.map(entryDto);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  restore(actor: Actor, id: string, expectedVersion: number) {
    return this.write(actor, async (tx) => {
      const entry = await this.entry(tx, actor.userId, id);
      checkVersion(expectedVersion, entry.version);
      if (!entry.deletedAt || !entry.purgeAfter)
        throw new AppError(409, 'ENTRY_NOT_DELETED', '事项不在回收站。');
      if (this.clock.now() >= entry.purgeAfter)
        throw new AppError(410, 'TRASH_EXPIRED', '事项已超过恢复期限。');
      const updated = await tx.entry.update({
        where: { id },
        data: { deletedAt: null, purgeAfter: null, version: { increment: 1 } },
      });
      return { data: await this.entryResult(tx, updated), changed: true };
    });
  }
  purge(actor: Actor, input: PurgeTrashInput) {
    return this.write(actor, async (tx) => {
      let ids: string[];
      if ('expectedDataVersion' in input) {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: actor.userId },
        });
        if (user.dataVersion.toString() !== input.expectedDataVersion)
          throw new AppError(
            409,
            'DATA_VERSION_CONFLICT',
            '回收站已有变化，请重新确认。',
            { currentDataVersion: user.dataVersion.toString() },
          );
        ids = (
          await tx.entry.findMany({
            where: { userId: actor.userId, deletedAt: { not: null } },
            select: { id: true },
          })
        ).map((entry) => entry.id);
      } else {
        if (
          new Set(input.entries.map((entry) => entry.id)).size !==
          input.entries.length
        )
          throw new AppError(422, 'VALIDATION_ERROR', '清理目标不能重复。');
        ids = input.entries.map((entry) => entry.id);
        const entries = await tx.entry.findMany({
          where: { userId: actor.userId, id: { in: ids } },
        });
        if (entries.length !== ids.length) throw notFound();
        const currentById = new Map(entries.map((entry) => [entry.id, entry]));
        for (const target of input.entries) {
          const entry = currentById.get(target.id);
          if (!entry) throw notFound();
          checkVersion(target.expectedVersion, entry.version);
          if (!entry.deletedAt)
            throw new AppError(409, 'ENTRY_NOT_DELETED', '事项不在回收站。');
        }
      }
      await tx.entry.deleteMany({
        where: {
          userId: actor.userId,
          id: { in: ids },
          deletedAt: { not: null },
        },
      });
      return {
        data: { success: true as const, purgedCount: ids.length },
        changed: ids.length > 0,
      };
    });
  }
  snapshot(actor: Actor, ifNoneMatch?: string) {
    return this.database.transaction(
      async (tx) => {
        const user = await this.readyUser(tx, actor.userId);
        if (
          !user ||
          user.status === 'merged' ||
          user.authEpoch !== actor.authEpoch
        )
          throw new AppError(401, 'SESSION_REVOKED', '登录状态已失效。');
        const today = businessToday(this.clock.now());
        const etag = `"dayline-1-${user.id}-${user.dataVersion}-${today}"`;
        if (
          ifNoneMatch
            ?.split(',')
            .map((value) => value.trim().replace(/^W\//, ''))
            .includes(etag)
        )
          return { etag, data: null };
        const categories = await tx.category.findMany({
          where: { userId: actor.userId },
          orderBy: categoryOrder,
        });
        const entries = await tx.$queryRaw<
          { active: EntryDto[]; trash: EntryDto[] }[]
        >`WITH public_entries AS (SELECT start_date, id, deleted_at, json_build_object('id',id,'categoryId',category_id,'title',title,'startDate',to_char(start_date,'YYYY-MM-DD'),'endDate',to_char(end_date,'YYYY-MM-DD'),'version',version,'focusVersion',focus_version,'deletedAt',to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'purgeAfter',to_char(purge_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS dto FROM entries WHERE user_id=${actor.userId}::uuid) SELECT COALESCE(json_agg(dto ORDER BY start_date,id) FILTER(WHERE deleted_at IS NULL),'[]'::json) AS active, COALESCE(json_agg(dto ORDER BY start_date,id) FILTER(WHERE deleted_at IS NOT NULL),'[]'::json) AS trash FROM public_entries`;
        // Aggregate only public focus fields in PG. Large snapshots avoid materializing
        // thousands of Prisma Date/updatedAt records before producing the same DTO.
        const focus = await tx.$queryRaw<
          { days: FocusDayDto[] }[]
        >`SELECT COALESCE(json_agg(json_build_object('entryId', f.entry_id, 'date', to_char(f.date, 'YYYY-MM-DD'), 'focused', f.focused, 'version', f.version) ORDER BY f.entry_id, f.date), '[]'::json) AS days FROM entry_focus_days f JOIN entries e ON e.id=f.entry_id WHERE e.user_id=${actor.userId}::uuid`;
        return {
          etag,
          data: {
            schemaVersion: 1 as const,
            userId: actor.userId,
            dataVersion: user.dataVersion.toString(),
            timeZone: 'Asia/Shanghai' as const,
            businessToday: today,
            complete: true as const,
            categories: categories.map(categoryDto),
            entries: entries[0]?.active ?? [],
            trashEntries: entries[0]?.trash ?? [],
            focusDays: focus[0]?.days ?? [],
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
