import { realEmailSchema } from './email.js';
import { z } from 'zod';
import {
  categoryDtoSchema,
  entryDtoSchema,
  focusDayDtoSchema,
  categoryNameSchema,
  colorSchema,
} from './records.js';
export const actionPurposeSchema = z.enum([
  'bind_email',
  'bind_wechat',
  'merge',
  'delete_account',
  'cancel_deletion',
  'recover_drafts',
]);
export const actionRequestSchema = z
  .object({
    purpose: actionPurposeSchema,
    operationId: z.uuid(),
    target: z.string().min(1).max(254),
  })
  .strict();
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export const reauthSchema = actionRequestSchema
  .extend({
    password: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.password) !== Boolean(v.code));
export const actionProofDtoSchema = z.object({
  proof: z.string().min(20).max(4096),
  expiresAt: z.iso.datetime(),
});
export const emailBindingCreateSchema = z
  .object({
    email: realEmailSchema,
    operationId: z.uuid(),
    proof: z.string().max(4096),
  })
  .strict();
export const emailBindingVerifySchema = z
  .object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const emailBindingCompleteSchema = z
  .object({
    operationId: z.uuid(),
    proof: z.string().max(4096),
    password: z.string().min(8).max(128).optional(),
    otherPassword: z.string().min(1).max(128).optional(),
  })
  .strict();
export const bindingResultSchema = z.object({
  status: z.enum(['pending', 'bound', 'merge_required']),
  id: z.uuid().optional(),
  mergeContext: z.uuid().optional(),
  reauthenticate: z.boolean().optional(),
});
export type BindingResult = z.infer<typeof bindingResultSchema>;
export const qrActionSchema = actionRequestSchema
  .extend({ proof: z.string().max(4096).optional() })
  .strict();
export const mergePreviewInputSchema = z
  .object({ contextId: z.uuid(), operationId: z.uuid() })
  .strict();
const summarySchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  entries: z.number().int().nonnegative(),
  trash: z.number().int().nonnegative(),
  categories: z.number().int().nonnegative(),
  focusDays: z.number().int().nonnegative(),
});
export const mergeCategorySchema = z.object({
  sourceId: z.uuid(),
  sourceName: z.string(),
  sourceColor: z.string(),
  targetId: z.uuid().nullable(),
  name: categoryNameSchema,
  color: colorSchema,
  needsReview: z.boolean(),
});
export const mergeMappingsSchema = z.object({
  mergeId: z.uuid(),
  sourceUserId: z.uuid(),
  targetUserId: z.uuid(),
  entries: z.array(z.object({ oldId: z.uuid(), newId: z.uuid() })),
  categories: z.array(z.object({ oldId: z.uuid(), newId: z.uuid() })),
});
export type MergeMappings = z.infer<typeof mergeMappingsSchema>;
export const mergePlanSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  status: z.enum(['preview', 'committed', 'cancelled', 'expired']),
  planRevision: z.number().int().positive(),
  planDigest: z.string(),
  expiresAt: z.iso.datetime(),
  sourceSummary: summarySchema,
  targetSummary: summarySchema,
  sourceDataVersion: z.string().regex(/^[1-9]\d*$/),
  targetDataVersion: z.string().regex(/^[1-9]\d*$/),
  targetCategories: z.array(categoryDtoSchema),
  categoryMappings: z.array(mergeCategorySchema),
  entries: z.array(entryDtoSchema),
  targetEntries: z.array(entryDtoSchema),
  targetFocusDays: z.array(focusDayDtoSchema),
  focusDays: z.array(focusDayDtoSchema),
  canCommit: z.boolean(),
  conflicts: z.array(z.string()),
  counts: z.object({
    retained: z.number().int(),
    reusedCategories: z.number().int(),
    newCategories: z.number().int(),
  }),
  displayNameFrom: z.enum(['target', 'source']),
  result: z
    .object({
      targetUserId: z.uuid(),
      sourceUserId: z.uuid(),
      dataVersion: z.string(),
      committedAt: z.iso.datetime(),
      reauthenticate: z.literal(true),
    })
    .nullable(),
});
export type MergePlan = z.infer<typeof mergePlanSchema>;
export const mergeReviewSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    categories: z
      .array(
        mergeCategorySchema.pick({
          sourceId: true,
          targetId: true,
          name: true,
          color: true,
        }),
      )
      .max(20),
    displayNameFrom: z.enum(['target', 'source']),
  })
  .strict();
export const mergeCommitSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    planDigest: z.string().max(100),
  })
  .strict();
export const mergeListSchema = z.array(
  z.object({
    id: z.uuid(),
    operationId: z.uuid(),
    status: z.string(),
    sourceUserId: z.uuid(),
    targetUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  }),
);

export type MergeReviewInput = z.infer<typeof mergeReviewSchema>;
export type MergeCommitInput = z.infer<typeof mergeCommitSchema>;
export type EmailBindingCompleteInput = z.infer<
  typeof emailBindingCompleteSchema
>;
export const emailBindingListSchema = z.array(
  z.object({
    id: z.uuid(),
    operationId: z.uuid(),
    email: realEmailSchema,
    status: z.enum(['pending', 'verified']),
    expiresAt: z.iso.datetime(),
  }),
);
export type EmailBindingItem = z.infer<typeof emailBindingListSchema>[number];

export function identityStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待验证',
    scanned: '已扫描，等待确认',
    confirmed: '已确认，等待领取',
    consumed: '本次操作已领取',
    cancelled: '已取消',
    expired: '已过期',
    preview: '待核对',
    committed: '已完成',
    verified: '邮件已验证',
  };
  return labels[status] ?? '状态待查询';
}

/** The exact editable selection. This is a client review baseline, never authorization. */
export function mergeReviewInput(plan: MergePlan): MergeReviewInput {
  return {
    expectedPlanRevision: plan.planRevision,
    categories: plan.categoryMappings.map((c) => ({
      sourceId: c.sourceId,
      targetId: c.targetId,
      name: c.name,
      color: c.color,
    })),
    displayNameFrom: plan.displayNameFrom,
  };
}
