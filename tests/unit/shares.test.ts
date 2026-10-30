import { describe, expect, it } from 'vitest';
import { formatShare, percentToBp } from '../../src/lib/shares';

describe('melos-rpr.29: percentages to basis points', () => {
  it('maps up to two decimals exactly', () => {
    expect(['60', '40', '33.33', '0.5', '100', '7.', ' 12.05 '].map(percentToBp)).toEqual([
      6000, 4000, 3333, 50, 10000, 700, 1205,
    ]);
  });

  it('refuses more decimals, signs, blanks and words', () => {
    expect(['12.345', '-1', '', '1e2', 'abc', '1000', '.5'].map(percentToBp)).toEqual(
      Array(7).fill(null),
    );
  });

  it('round-trips with formatShare', () => {
    expect(formatShare(percentToBp('33.33') ?? 0)).toBe('33.33%');
  });
});
