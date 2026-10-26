import { describe, expect, it } from 'vitest';
import { displayNameSchema } from '../src/index.js';

describe('registration display name', () => {
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(displayNameSchema.safeParse('😀'.repeat(40)).success).toBe(true);
    expect(displayNameSchema.safeParse('😀'.repeat(41)).success).toBe(false);
  });

  it('trims names and rejects empty input', () => {
    expect(displayNameSchema.parse('  读者  ')).toBe('读者');
    expect(displayNameSchema.safeParse('  ').success).toBe(false);
  });
});
