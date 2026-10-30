import { describe, expect, it } from 'vitest';
import {
  formatIsrc,
  formatIswc,
  formatPlaybackTime,
  normalizeIpi,
  normalizeIsrc,
  normalizeIswc,
  normalizeUpcEan,
} from '../../src/lib/identifiers';

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

const stores = (value: string) => ({ ok: true, value });
const refused = (code: string, reason: 'shape' | 'check_digit') => ({
  ok: false,
  error: { code, reason },
});
const digits = [...'0123456789'];

describe('normalizeIsrc (§4.4)', () => {
  it.each([
    ['US-DMO-26-00001', 'USDMO2600001'],
    ['USDMO2600001', 'USDMO2600001'],
    ['us-dmo-26-00001', 'USDMO2600001'],
    [' US DMO 26 00001 ', 'USDMO2600001'],
  ])('stores %j as %s', (input, value) => expect(normalizeIsrc(input)).toEqual(stores(value)));

  const shapes = ['', 'USDMO260001', 'USDMO26000012', 'US-DMO-2A-00001', 'US.DMO.26.00001'];
  it.each([...shapes, 'ıSDMO2600001'])('refuses %j by its shape', (input) =>
    expect(normalizeIsrc(input)).toEqual(refused('INVALID_ISRC', 'shape')),
  );
});

describe('normalizeIswc (§4.4, D-2)', () => {
  it.each([
    ['T-034.524.680-1', 'T0345246801'],
    ['T0345246801', 'T0345246801'],
    ['t-034.524.680-1', 'T0345246801'],
    ['T 034 524 680 1', 'T0345246801'],
  ])('stores %j as %s', (input, value) => expect(normalizeIswc(input)).toEqual(stores(value)));

  it('accepts only the ISO 15707 check digit on a new value', () => {
    expect(digits.filter((digit) => normalizeIswc(`T-034.524.680-${digit}`).ok)).toEqual(['1']);
    expect(normalizeIswc('T-034.524.680-2')).toEqual(refused('INVALID_ISWC', 'check_digit'));
  });

  it.each(['T9000000010', 'T9000000020', 'T9000000030', 'T9000000040', 'T9000000050'])(
    'keeps the §2.6 fixture ISWC %s, which fails the check, only while it is unchanged',
    (iswc) => {
      expect(normalizeIswc(formatIswc(iswc), { stored: iswc })).toEqual(stores(iswc));
      expect(normalizeIswc(iswc)).toEqual(refused('INVALID_ISWC', 'check_digit'));
    },
  );

  it('checks a changed value', () => {
    const stored = 'T9000000010';
    expect(normalizeIswc('T9000000011', { stored })).toEqual(stores('T9000000011'));
    expect(normalizeIswc('T9000000020', { stored })).toEqual(
      refused('INVALID_ISWC', 'check_digit'),
    );
  });

  const shapes = ['', 'T034524680', 'T03452468011', '0345246801', 'X-034.524.680-1'];
  it.each([...shapes, 'T-034.524.68A-1', 'T/034.524.680-1'])('refuses %j by its shape', (input) => {
    expect(normalizeIswc(input)).toEqual(refused('INVALID_ISWC', 'shape'));
    expect(normalizeIswc(input, { stored: input })).toEqual(refused('INVALID_ISWC', 'shape'));
  });
});

describe('normalizeUpcEan (§4.4, D-1)', () => {
  it.each([
    ['036000291452', '036000291452'],
    ['0 36000 29145 2', '036000291452'],
    ['0012345678905', '0012345678905'],
    ['5012345670003', '5012345670003'],
    ['501-2345-67000-3', '5012345670003'],
  ])('stores %j as %s with its leading zeros', (input, value) =>
    expect(normalizeUpcEan(input)).toEqual(stores(value)),
  );

  it.each([
    ['03600029145', '2'],
    ['001234567890', '5'],
    ['501234567000', '3'],
  ])('accepts only the GS1 check digit after %s', (body, check) => {
    expect(digits.filter((digit) => normalizeUpcEan(`${body}${digit}`).ok)).toEqual([check]);
    const wrong = `${body}${(Number(check) + 1) % 10}`;
    expect(normalizeUpcEan(wrong)).toEqual(refused('INVALID_UPC_EAN', 'check_digit'));
  });

  const shapes = ['', '12345670', '03600029145', '00036000291452', '03600029145A'];
  it.each([...shapes, '036000.291452'])('refuses %j by its shape', (input) =>
    expect(normalizeUpcEan(input)).toEqual(refused('INVALID_UPC_EAN', 'shape')),
  );
});

describe('normalizeIpi (§4.4, P-47)', () => {
  it.each([
    ['00012345678', '00012345678'],
    ['123456789', '00123456789'],
    ['1234567890', '01234567890'],
    [' 123.456.789 ', '00123456789'],
    ['001-234-567-89', '00123456789'],
  ])('stores the name number %j as %s', (input, value) =>
    expect(normalizeIpi(input, 'IPI')).toEqual({ ok: true, value }),
  );

  it.each(['', '12345678', '123456789012', '12345678A', '１２３４５６７８９'])(
    'refuses the name number %j by its shape',
    (input) => expect(normalizeIpi(input, 'IPI')).toEqual(refused('INVALID_IPI', 'shape')),
  );

  it.each([
    ['I-000000229-7', 'I-000000229-7'],
    ['I0000002297', 'I-000000229-7'],
    ['i-000000229 -7', 'I-000000229-7'],
  ])('stores the base number %j as %s', (input, value) =>
    expect(normalizeIpi(input, 'IPI_BASE')).toEqual({ ok: true, value }),
  );

  it.each(['', '0000002297', 'I-00000229-7', 'I-000000229-77', 'X-000000229-7'])(
    'refuses the base number %j by its shape',
    (input) => expect(normalizeIpi(input, 'IPI_BASE')).toEqual(refused('INVALID_IPI', 'shape')),
  );
});
