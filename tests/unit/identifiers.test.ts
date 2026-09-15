import { describe, expect, it } from 'vitest';
import { formatIsrc, formatIswc, formatPlaybackTime } from '../../src/lib/identifiers';

describe('identifier display formats (§2.6)', () => {
  it('adds the separators to a stored ISRC and ISWC', () => {
    expect(formatIsrc('USDMO2600001')).toBe('US-DMO-26-00001');
    expect(formatIswc('T9000000010')).toBe('T-900.000.001-0');
  });

  const others = ['US-DMO-26-00001', 'usdmo2600001', 'USDMO26000012', 'T-900.000.001-0'];
  it.each([...others, 't9000000010', 'T900000001', ''])('returns %j unchanged', (value) => {
    expect(formatIsrc(value)).toBe(value);
    expect(formatIswc(value)).toBe(value);
  });

  it.each([
    [0, '0:00'],
    [42_000, '0:42'],
    [35_999, '0:35'],
    [61_000, '1:01'],
    [3_600_000, '60:00'],
  ])('formats %i ms as %s', (ms, text) => expect(formatPlaybackTime(ms)).toBe(text));
});
