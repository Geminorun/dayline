import { z } from 'zod';
import {
  createEntrySchema,
  entryDtoSchema,
  snapshotDtoSchema,
} from './records.js';
export function compareDataVersions(a: string, b: string): number {
  return a.length === b.length
    ? a === b
      ? 0
      : a < b
        ? -1
        : 1
    : a.length < b.length
      ? -1
      : 1;
}
export const snapshotEnvelopeSchema = z
  .object({
    localSchemaVersion: z.literal(1),
    environment: z.string(),
    scope: z.literal('account'),
    userId: z.uuid(),
    complete: z.literal(true),
    savedAt: z.iso.datetime(),
    etag: z.string().nullable(),
    serverTime: z.iso.datetime(),
    payload: snapshotDtoSchema,
  })
  .strict()
  .refine((e) => e.userId === e.payload.userId);
export type SnapshotEnvelope = z.infer<typeof snapshotEnvelopeSchema>;
export const draftSchema = z
  .object({
    format: z.literal('dayline-draft'),
    localSchemaVersion: z.literal(1),
    environment: z.string(),
    userId: z.uuid(),
    draftId: z.uuid(),
    entryId: z.uuid(),
    baseEntryVersion: z.number().int().positive().nullable(),
    baseEntry: entryDtoSchema.nullable(),
    inputRevision: z.number().int().nonnegative(),
    persistedRevision: z.number().int().nonnegative(),
    savedLocallyAt: z.iso.datetime(),
    fields: createEntrySchema
      .pick({ title: true, startDate: true, endDate: true, categoryId: true })
      .partial()
      .extend({
        title: z.string(),
        startDate: z.string(),
        endDate: z.string().nullable(),
        categoryId: z.string(),
      }),
  })
  .strict()
  .refine(
    (d) =>
      d.persistedRevision === d.inputRevision &&
      ((d.baseEntryVersion === null && d.baseEntry === null) ||
        (d.baseEntry !== null &&
          d.baseEntry.id === d.entryId &&
          d.baseEntryVersion === d.baseEntry.version)),
  );
export type EntryDraft = z.infer<typeof draftSchema>;

export const localChunksManifestSchema = z
  .object({
    generation: z.string(),
    chunks: z.number().int().positive().max(200),
    length: z.number().int().positive(),
    checksum: z.string(),
  })
  .strict();
