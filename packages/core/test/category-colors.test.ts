import { describe, expect, it } from 'vitest';
import { CATEGORY_PALETTE, nextCategoryColor } from '../src/index.js';
describe('category color priority', () => {
  it('prefers unused colors, ignores hex case and cycles by least usage with stable ties', () => {
    const used: string[] = [];
    for (const expected of CATEGORY_PALETTE) {
      const actual = nextCategoryColor(used.map((c) => c.toLowerCase()));
      expect(actual).toBe(expected);
      used.push(actual);
    }
    expect(new Set(used).size).toBe(CATEGORY_PALETTE.length);
    used.push(nextCategoryColor(used));
    expect(nextCategoryColor(used)).toBe(CATEGORY_PALETTE[1]);
    expect(nextCategoryColor(['#000000'])).toBe(CATEGORY_PALETTE[0]);
  });
});
