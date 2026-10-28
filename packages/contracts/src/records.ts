import { z } from 'zod';
import { isCalendarDate } from '@dayline/core';
export const dateSchema = z
  .string()
  .refine(isCalendarDate, '须为有效 YYYY-MM-DD 日期（0001–9999）。');
export const versionSchema = z.number().int().min(1).max(2147483647);
export const dataVersionSchema = z.string().regex(/^[1-9]\d*$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => [...value].length >= 1 && [...value].length <= max);
export const categoryNameSchema = text(12);
export const titleSchema = text(100);
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toUpperCase());
const categoryFields = { name: categoryNameSchema, color: colorSchema };
export const createCategorySchema = z
  .object({ id: z.uuid(), ...categoryFields })
  .strict();
export const patchCategorySchema = z
  .object({
    expectedVersion: versionSchema,
    name: categoryNameSchema.optional(),
    color: colorSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined);
const transferCategorySchema = z
  .object({
    expectedVersion: versionSchema,
    transferToCategoryId: z.uuid(),
    expectedTargetVersion: versionSchema,
  })
  .strict();
export const deleteCategorySchema = z.union([
  transferCategorySchema,
  z
    .object({
      expectedVersion: versionSchema,
      mode: z.literal('trash'),
      expectedDataVersion: dataVersionSchema,
      fallbackCategoryId: z.uuid(),
    })
    .strict(),
]);
export const reorderCategoriesSchema = z
  .object({
    expectedDataVersion: dataVersionSchema,
    categoryIds: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;
const entryFields = {
  categoryId: z.uuid(),
  title: titleSchema,
  startDate: dateSchema,
  endDate: dateSchema.nullable(),
};
export const createEntrySchema = z
  .object({ id: z.uuid(), ...entryFields })
  .strict();
export const focusAcknowledgementSchema = z
  .object({ date: dateSchema, version: versionSchema })
  .strict();
export const MAX_FOCUS_REMOVAL_ACKNOWLEDGEMENTS = 20_000;
export const patchEntrySchema = z
  .object({
    expectedVersion: versionSchema,
    categoryId: z.uuid().optional(),
    title: titleSchema.optional(),
    startDate: dateSchema.optional(),
    endDate: dateSchema.nullable().optional(),
    focusRemovalAcknowledgement: z
      .array(focusAcknowledgementSchema)
      .max(MAX_FOCUS_REMOVAL_ACKNOWLEDGEMENTS)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.categoryId !== undefined ||
      value.title !== undefined ||
      value.startDate !== undefined ||
      value.endDate !== undefined,
  );
export const expectedVersionSchema = z
  .object({ expectedVersion: versionSchema })
  .strict();
export const setFocusSchema = z
  .object({
    focused: z.boolean(),
    expectedEntryVersion: versionSchema,
    expectedFocusVersion: z.number().int().min(0).max(2147483647),
  })
  .strict();
export const MAX_TRASH_PURGE_ENTRIES = 1000;
export const purgeTrashSchema = z.union([
  z.object({ expectedDataVersion: dataVersionSchema }).strict(),
  z
    .object({
      entries: z
        .array(
          z.object({ id: z.uuid(), expectedVersion: versionSchema }).strict(),
        )
        .min(1)
        .max(MAX_TRASH_PURGE_ENTRIES),
    })
    .strict(),
]);
export const categoryDtoSchema = z.object({
  id: z.uuid(),
  ...categoryFields,
  seedKey: z.string().nullable(),
  version: versionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const entryDtoSchema = z.object({
  id: z.uuid(),
  ...entryFields,
  version: versionSchema,
  focusVersion: versionSchema,
  deletedAt: z.iso.datetime().nullable(),
  purgeAfter: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const focusDayDtoSchema = z.object({
  entryId: z.uuid(),
  date: dateSchema,
  focused: z.boolean(),
  version: z.number().int().nonnegative(),
});
export const snapshotDtoSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.uuid(),
    dataVersion: dataVersionSchema,
    timeZone: z.literal('Asia/Shanghai'),
    businessToday: dateSchema,
    complete: z.literal(true),
    categories: z.array(categoryDtoSchema),
    entries: z.array(entryDtoSchema),
    trashEntries: z.array(entryDtoSchema),
    focusDays: z.array(focusDayDtoSchema),
  })
  .superRefine((data, ctx) => {
    const categoryIds = new Set(data.categories.map((c) => c.id));
    const entries = [...data.entries, ...data.trashEntries];
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const focusKeys = new Set<string>();
    if (
      !data.categories.length ||
      categoryIds.size !== data.categories.length ||
      new Set(data.categories.map((c) => c.name)).size !==
        data.categories.length ||
      entryById.size !== entries.length
    )
      ctx.addIssue({ code: 'custom', message: '重复标识或分类缺失' });
    for (const [trash, collection] of [
      [false, data.entries],
      [true, data.trashEntries],
    ] as const)
      for (const entry of collection)
        if (
          !categoryIds.has(entry.categoryId) ||
          (entry.endDate !== null && entry.endDate < entry.startDate) ||
          (entry.deletedAt !== null) !== trash ||
          (entry.purgeAfter !== null) !== trash ||
          (entry.deletedAt &&
            entry.purgeAfter &&
            Date.parse(entry.purgeAfter) <= Date.parse(entry.deletedAt))
        )
          ctx.addIssue({ code: 'custom', message: '事项分区或引用损坏' });
    for (const day of data.focusDays) {
      const key = day.entryId + ':' + day.date,
        entry = entryById.get(day.entryId);
      if (
        focusKeys.has(key) ||
        !entry ||
        day.version < 1 ||
        (day.focused &&
          (day.date > data.businessToday ||
            day.date < entry.startDate ||
            (entry.endDate !== null && day.date > entry.endDate)))
      )
        ctx.addIssue({ code: 'custom', message: '重点引用或日期损坏' });
      focusKeys.add(key);
    }
  });
export const entryResultSchema = z.object({
  entry: entryDtoSchema,
  focusDays: z.array(focusDayDtoSchema),
  alreadyExists: z.boolean().optional(),
});
export const categoryResultSchema = z.object({
  category: categoryDtoSchema,
  alreadyExists: z.boolean().optional(),
});
export const focusResultSchema = z.object({
  focusDay: focusDayDtoSchema,
  focusVersion: versionSchema,
});
export const versionConflictDetailsSchema = z
  .object({
    expectedVersion: z.number().int(),
    currentVersion: z.number().int().nonnegative(),
  })
  .passthrough();
export const focusRemovalDetailsSchema = z.object({
  currentVersion: versionSchema,
  affectedFocusDays: z.array(focusAcknowledgementSchema),
});
export type CategoryDto = z.infer<typeof categoryDtoSchema>;
export type EntryDto = z.infer<typeof entryDtoSchema>;
export type FocusDayDto = z.infer<typeof focusDayDtoSchema>;
export type SnapshotDto = z.infer<typeof snapshotDtoSchema>;
export type CreateEntryInput = z.infer<typeof createEntrySchema>;
export type PatchEntryInput = z.infer<typeof patchEntrySchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type PatchCategoryInput = z.infer<typeof patchCategorySchema>;
export type DeleteCategoryInput = z.infer<typeof deleteCategorySchema>;
export type SetFocusInput = z.infer<typeof setFocusSchema>;
export type PurgeTrashInput = z.infer<typeof purgeTrashSchema>;

export const purgeResultSchema = z.object({
  success: z.literal(true),
  purgedCount: z.number().int().nonnegative(),
});
export const deleteCategoryResultSchema = z.object({
  success: z.literal(true),
  transferredCount: z.number().int().nonnegative(),
  trashedCount: z.number().int().nonnegative().optional(),
});
export type DeleteCategoryResult = z.infer<typeof deleteCategoryResultSchema>;
export const categoryOrderResultSchema = z.object({
  categories: z.array(categoryDtoSchema),
});
export const serverTimeSchema = z.iso.datetime();
