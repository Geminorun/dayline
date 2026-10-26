import { expect, it } from 'vitest';
import {
  createCategorySchema,
  createEntrySchema,
  dateSchema,
  patchEntrySchema,
  purgeTrashSchema,
} from '../src/index.js';
const id = '82264845-088c-4d52-8536-fab20c0f3407';
it('normalizes business text by Unicode codepoint and rejects extra ownership fields', () => {
  expect(
    createCategorySchema.parse({ id, name: ' 😀'.repeat(1), color: '#abcdef' })
      .color,
  ).toBe('#ABCDEF');
  expect(
    createCategorySchema.safeParse({
      id,
      name: '😀'.repeat(12),
      color: '#ABCDEF',
    }).success,
  ).toBe(true);
  expect(
    createCategorySchema.safeParse({
      id,
      name: '😀'.repeat(13),
      color: '#ABCDEF',
    }).success,
  ).toBe(false);
  const entry = {
    id,
    title: '😀'.repeat(100),
    categoryId: id,
    startDate: '0001-01-01',
    endDate: null,
  };
  expect(createEntrySchema.safeParse(entry).success).toBe(true);
  expect(
    createEntrySchema.safeParse({ ...entry, title: '😀'.repeat(101) }).success,
  ).toBe(false);
  expect(createEntrySchema.safeParse({ ...entry, userId: id }).success).toBe(
    false,
  );
  expect(dateSchema.safeParse('2026-02-29').success).toBe(false);
  expect(patchEntrySchema.safeParse({ expectedVersion: 1 }).success).toBe(
    false,
  );
  expect(
    purgeTrashSchema.safeParse({ expectedDataVersion: '9007199254740993' })
      .success,
  ).toBe(true);
  expect(purgeTrashSchema.safeParse({ expectedDataVersion: 42 }).success).toBe(
    false,
  );
});
