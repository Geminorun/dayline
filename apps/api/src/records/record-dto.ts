import type {
  Category,
  Entry,
  EntryFocusDay,
} from '../generated/prisma/client.js';
import type { CategoryDto, EntryDto, FocusDayDto } from '@dayline/contracts';
export function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
export function databaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
export function categoryDto(value: Category): CategoryDto {
  return {
    id: value.id,
    name: value.name,
    color: value.color,
    seedKey: value.seedKey,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
export function entryDto(value: Entry): EntryDto {
  return {
    id: value.id,
    categoryId: value.categoryId,
    title: value.title,
    startDate: calendarDate(value.startDate),
    endDate: value.endDate ? calendarDate(value.endDate) : null,
    version: value.version,
    focusVersion: value.focusVersion,
    deletedAt: value.deletedAt?.toISOString() ?? null,
    purgeAfter: value.purgeAfter?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
export function focusDto(value: EntryFocusDay): FocusDayDto {
  return {
    entryId: value.entryId,
    date: calendarDate(value.date),
    focused: value.focused,
    version: value.version,
  };
}
