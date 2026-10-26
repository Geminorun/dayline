import { describe, expect, it } from 'vitest';
import {
  businessToday,
  coversDate,
  dateOrdinal,
  durationDays,
  entryStatus,
  intersectsRange,
  isCalendarDate,
  summarizeEntries,
} from '../src/index.js';
describe('pure Gregorian business rules', () => {
  it('accepts only exact Gregorian dates over 0001–9999', () => {
    for (const value of [
      '0001-01-01',
      '0099-12-31',
      '2000-02-29',
      '2024-02-29',
      '9999-12-31',
    ])
      expect(isCalendarDate(value)).toBe(true);
    for (const value of [
      '0000-01-01',
      '10000-01-01',
      '1900-02-29',
      '2026-02-29',
      '2024-04-31',
      '2026-1-01',
      '2026-01-01T00:00:00Z',
    ])
      expect(isCalendarDate(value)).toBe(false);
    expect(() => dateOrdinal('bad')).toThrow(RangeError);
    expect(dateOrdinal('0100-01-01') - dateOrdinal('0099-12-31')).toBe(1);
    expect(dateOrdinal('2000-03-01') - dateOrdinal('2000-02-28')).toBe(2);
  });
  it('uses Shanghai midnight regardless of the host timezone', () => {
    expect(businessToday(new Date('2026-10-25T15:59:59.999Z'))).toBe(
      '2026-10-25',
    );
    expect(businessToday(new Date('2026-10-25T16:00:00.000Z'))).toBe(
      '2026-10-26',
    );
  });
  it('counts inclusive calendar days and keeps open entries out of future review', () => {
    const today = '2026-10-26';
    const entry = { startDate: '2026-10-25', endDate: null, categoryId: 'a' };
    expect(durationDays(entry, today)).toBe(2);
    expect(durationDays({ ...entry, startDate: '2026-10-27' }, today)).toBe(0);
    expect(coversDate(entry, '2026-10-27', today)).toBe(false);
    expect(coversDate({ ...entry, endDate: today }, today, today)).toBe(true);
    expect(entryStatus({ ...entry, endDate: today }, today)).toBe('ended');
    expect(entryStatus({ ...entry, startDate: '2026-10-27' }, today)).toBe(
      'not_started',
    );
    expect(intersectsRange(entry, '2026-10-01', '2026-10-25', today)).toBe(
      true,
    );
    expect(
      summarizeEntries([entry, { ...entry, endDate: today }], today),
    ).toEqual({ count: 2, ongoing: 1, categoryCount: 1, categories: { a: 2 } });
    expect(summarizeEntries([], today).categoryCount).toBe(0);
  });
});
