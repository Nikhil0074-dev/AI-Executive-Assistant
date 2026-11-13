import { describe, it, expect } from 'vitest';
import { clip, intersect, invert, isFree, mergeIntervals, overlaps } from '../src/utils/intervals';

describe('intervals', () => {
  it('merges overlapping and adjacent intervals and drops empty ones', () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 10 }, { start: 20, end: 20 }])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 10 },
    ]);
  });
  it('does not mutate its input', () => {
    const input = [{ start: 1, end: 3 }, { start: 2, end: 5 }];
    mergeIntervals(input);
    expect(input).toEqual([{ start: 1, end: 3 }, { start: 2, end: 5 }]);
  });
  it('treats intervals as half-open', () => {
    expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
    expect(overlaps({ start: 0, end: 5 }, { start: 4, end: 9 })).toBe(true);
    expect(isFree([{ start: 10, end: 20 }], { start: 20, end: 30 })).toBe(true);
    expect(isFree([{ start: 10, end: 20 }], { start: 19, end: 30 })).toBe(false);
  });
  it('inverts busy time into free time within a window', () => {
    expect(invert([{ start: 2, end: 4 }, { start: 6, end: 7 }], { start: 0, end: 10 })).toEqual([
      { start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 10 },
    ]);
    expect(invert([{ start: -5, end: 3 }, { start: 8, end: 20 }], { start: 0, end: 10 })).toEqual([{ start: 3, end: 8 }]);
    expect(invert([], { start: 0, end: 10 })).toEqual([{ start: 0, end: 10 }]);
    expect(invert([{ start: 0, end: 10 }], { start: 0, end: 10 })).toEqual([]);
  });
  it('intersects sorted lists', () => {
    expect(intersect([{ start: 0, end: 5 }, { start: 8, end: 12 }], [{ start: 3, end: 9 }, { start: 11, end: 20 }])).toEqual([
      { start: 3, end: 5 }, { start: 8, end: 9 }, { start: 11, end: 12 },
    ]);
    expect(intersect([], [{ start: 0, end: 1 }])).toEqual([]);
  });
  it('clips intervals to a window', () => {
    expect(clip([{ start: 0, end: 10 }, { start: 30, end: 40 }], { start: 5, end: 20 })).toEqual([{ start: 5, end: 10 }]);
  });
});
