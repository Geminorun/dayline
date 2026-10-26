import { z } from 'zod';
import { businessToday } from '@dayline/core';
import { guestPackageSchema } from './guest.js';
import {
  categoryDtoSchema,
  entryDtoSchema,
  focusDayDtoSchema,
  categoryNameSchema,
  colorSchema,
  dataVersionSchema,
  snapshotDtoSchema,
} from './records.js';
export const MAX_IMPORT_ENTRIES = 10_000;
export const MAX_IMPORT_FOCUS = 100_000;
export const guestAdmissionSchema = z
  .object({ clientOperationId: z.uuid(), package: guestPackageSchema })
  .strict()
  .refine(
    (v) =>
      v.package.entries.length <= MAX_IMPORT_ENTRIES &&
      v.package.focusDays.length <= MAX_IMPORT_FOCUS,
  );
export const categoryMappingSchema = z.object({
  sourceId: z.uuid(),
  candidateId: z.uuid(),
  targetId: z.uuid().nullable(),
  name: categoryNameSchema,
  color: colorSchema,
  seedKey: z.string().nullable(),
  needsReview: z.boolean(),
  sourceKey: z.string().optional(),
  sourceDigest: z.string().optional(),
  previousTargetId: z.uuid().nullable().optional(),
  action: z.enum(['apply', 'skip']).optional(),
  restoreDefault: categoryDtoSchema.optional(),
  asCustom: z.boolean().optional(),
});
export const importRowSchema = z.object({
  sourceKey: z.string().min(1).max(160),
  sourceDigest: z.string(),
  candidateId: z.uuid(),
  source: entryDtoSchema,
  focusDays: z.array(focusDayDtoSchema),
  action: z.enum([
    'create_copy',
    'skip',
    'needs_review',
    'apply_update',
    'restore',
    'unchanged',
  ]),
  file: z
    .object({
      location: z.string(),
      requestedId: z.string().nullable(),
      categoryReference: z.string().nullable().optional(),
      categoryName: z.string().nullable().optional(),
      entryVersion: z.number().int().nullable(),
      focusVersion: z.number().int().nullable(),
      endPresent: z.boolean(),
      categoryPresent: z.boolean(),
      focusPresent: z.boolean(),
      errors: z.array(z.string()),
      current: entryDtoSchema.nullable(),
      currentFocusDays: z.array(focusDayDtoSchema).optional(),
      currentCategory: categoryDtoSchema.optional(),
      differences: z.array(z.string()),
      categoryAmbiguous: z.boolean(),
    })
    .optional(),
  previousTargetId: z.uuid().nullable(),
  reason: z.string().nullable(),
  code: z.string().optional(),
  processed: z.boolean().optional(),
  choice: z.enum(['create_copy', 'skip', 'apply_update', 'restore']).optional(),
});
export const importResultSchema = z.object({
  dataVersion: dataVersionSchema,
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative().optional(),
  unchanged: z.number().int().nonnegative().optional(),
  mappings: z.array(
    z.object({
      sourceKey: z.string().min(1).max(160),
      sourceDigest: z.string(),
      targetId: z.uuid(),
    }),
  ),
  categoryMappings: z
    .array(
      z.object({
        sourceKey: z.string(),
        sourceDigest: z.string(),
        targetId: z.uuid(),
      }),
    )
    .optional(),
  committedAt: z.iso.datetime(),
});
export const importJobSchema = z.object({
  id: z.uuid(),
  clientOperationId: z.uuid(),
  kind: z.enum(['guest', 'csv', 'json']),
  status: z.enum(['preview', 'committed', 'cancelled', 'expired']),
  disposition: z.enum(['preview_required', 'committed']),
  inputDigest: z.string(),
  planDigest: z.string(),
  planRevision: z.number().int().positive(),
  baseDataVersion: dataVersionSchema,
  expiresAt: z.iso.datetime(),
  canCommit: z.boolean(),
  sourceSummary: z.object({
    entries: z.number(),
    categories: z.number(),
    focusDays: z.number(),
  }),
  targetSummary: z.object({
    entries: z.number(),
    categories: z.number(),
    focusDays: z.number(),
  }),
  categoryMappings: z.array(categoryMappingSchema),
  rows: z.array(importRowSchema),
  result: importResultSchema.nullable(),
  counts: z
    .object({
      create: z.number(),
      update: z.number(),
      unchanged: z.number(),
      needsReview: z.number(),
      errors: z.number(),
      skip: z.number(),
    })
    .optional(),
});
export const importReviewSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    categories: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            targetId: z.uuid().nullable(),
            name: categoryNameSchema,
            color: colorSchema,
            asCustom: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20),
    rows: z
      .array(
        z
          .object({
            sourceKey: z.string().min(1).max(160),
            action: z.enum(['create_copy', 'skip', 'apply_update', 'restore']),
            expectedEntryVersion: z.number().int().positive().optional(),
            expectedFocusVersion: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(MAX_IMPORT_ENTRIES),
  })
  .strict();
export const importCommitSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    planDigest: z.string().max(100),
  })
  .strict();
export type ImportJobDto = z.infer<typeof importJobSchema>;
export type ImportReviewInput = z.infer<typeof importReviewSchema>;
export type ImportCommitInput = z.infer<typeof importCommitSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export type CategoryMapping = z.infer<typeof categoryMappingSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
export type GuestAdmissionInput = z.infer<typeof guestAdmissionSchema>;
// A durable immutable input: receiving an old receipt never marks a later revision.
export const admissionOperationSchema = z
  .object({
    environment: z.string(),
    userId: z.uuid(),
    clientOperationId: z.uuid(),
    package: guestPackageSchema,
    jobId: z.uuid().nullable(),
    status: z.enum(['pending', 'committed', 'cancelled', 'expired', 'missing']),
    result: importResultSchema.nullable(),
  })
  .strict();
export type AdmissionOperation = z.infer<typeof admissionOperationSchema>;
export const importCloudSchema = z.object({
  categories: z.array(categoryDtoSchema),
  entries: z.array(entryDtoSchema),
  focusDays: z.array(focusDayDtoSchema),
});

// Platform/file parsers normalize into this bounded source; permission still comes from Actor.
export const normalizedImportSourceSchema = z
  .object({
    sourceNamespace: z.string().min(1).max(80),
    sourceRevision: z.string().min(1).max(100),
    savedAt: z.iso.datetime(),
    categories: z.array(categoryDtoSchema).min(1).max(20),
    entries: z.array(entryDtoSchema).max(MAX_IMPORT_ENTRIES),
    focusDays: z.array(focusDayDtoSchema).max(MAX_IMPORT_FOCUS),
    file: z
      .object({
        digest: z.string(),
        rows: z
          .array(importRowSchema.shape.file.unwrap())
          .max(MAX_IMPORT_ENTRIES),
      })
      .optional(),
  })
  .strict()
  .refine(
    (source) =>
      source.file !== undefined ||
      snapshotDtoSchema.safeParse({
        schemaVersion: 1,
        userId: '00000000-0000-4000-8000-000000000001',
        dataVersion: '1',
        timeZone: 'Asia/Shanghai',
        businessToday: businessToday(new Date(source.savedAt)),
        complete: true,
        categories: source.categories,
        entries: source.entries.filter((e) => !e.deletedAt),
        trashEntries: source.entries.filter((e) => e.deletedAt),
        focusDays: source.focusDays,
      }).success,
  );
export type NormalizedImportSource = z.infer<
  typeof normalizedImportSourceSchema
>;

export const fileOperationSchema = z
  .object({
    environment: z.string(),
    scope: z.enum(['guest', 'account']),
    ownerId: z.uuid(),
    clientOperationId: z.uuid(),
    jobId: z.uuid().nullable(),
    format: z.enum(['csv', 'json']),
    text: z.string().max(10 * 1024 * 1024),
    status: z.enum(['pending', 'committed', 'cancelled', 'expired']),
    localPlan: importJobSchema.nullable(),
  })
  .strict();
export type FileOperation = z.infer<typeof fileOperationSchema>;

export const fileReceiptsSchema = z
  .object({
    environment: z.string(),
    ownerId: z.uuid(),
    receipts: z.array(importResultSchema),
  })
  .strict();

/** Keep every completed content revision; completion timestamps are not a total order. */
export function importReceiptIndex(receipts: ImportResult[]) {
  const index = new Map<
    string,
    { sourceKey: string; sourceDigest: string; targetId: string }
  >();
  for (const receipt of receipts)
    for (const mapping of [
      ...receipt.mappings,
      ...(receipt.categoryMappings ?? []),
    ]) {
      index.set(mapping.sourceKey, mapping);
      index.set(mapping.sourceKey + '@' + mapping.sourceDigest, mapping);
    }
  return index;
}
export function importSourceReceipt(
  index: ReadonlyMap<string, { sourceDigest: string; targetId: string }>,
  key: string,
  digest: string,
) {
  return index.get(key + '@' + digest) ?? index.get(key);
}

/** Bounded JSON selections only: a local UI baseline, never a server authorization or plan digest. */
export function reviewSelectionKey(selection: object): string {
  return JSON.stringify(selection);
}
