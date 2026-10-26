import { draftSchema } from '@dayline/contracts';
import type { EntryDraft, MergeMappings } from '@dayline/contracts';
/** Called only after server-authorized mappings, never on a normal account switch. */
export function recoverMergeDraft(
  source: EntryDraft,
  mapping: MergeMappings,
  draftId: string,
  copyEntryId: string,
  savedAt: string,
  selectedCategoryId?: string,
): EntryDraft {
  if (source.userId !== mapping.sourceUserId)
    throw new Error('Draft owner does not match authorized merge');
  const entry = mapping.entries.find((e) => e.oldId === source.entryId),
    category = mapping.categories.find(
      (c) => c.oldId === source.fields.categoryId,
    );
  const baseCategory = source.baseEntry
    ? mapping.categories.find((c) => c.oldId === source.baseEntry?.categoryId)
    : null;
  const reliable = Boolean(
    entry && source.baseEntry && baseCategory && category,
  );
  const categoryId = category?.newId ?? selectedCategoryId;
  if (!categoryId) throw new Error('请明确选择目标分类；旧草稿原文保留。');
  return draftSchema.parse({
    ...source,
    userId: mapping.targetUserId,
    draftId,
    entryId: reliable && entry ? entry.newId : copyEntryId,
    baseEntryVersion: reliable ? source.baseEntryVersion : null,
    baseEntry:
      reliable && source.baseEntry && entry && baseCategory
        ? {
            ...source.baseEntry,
            id: entry.newId,
            categoryId: baseCategory.newId,
          }
        : null,
    fields: { ...source.fields, categoryId },
    inputRevision: 1,
    persistedRevision: 1,
    savedLocallyAt: savedAt,
  });
}
