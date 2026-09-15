/**
 * Identifiers and times (docs/CONTRACT.md §1.4, §2.6, §4.4). The format functions only display: a
 * value in any other shape comes back unchanged. The normalize functions turn user input into the
 * value to store or a typed refusal; they import nothing, so forms and services share them.
 */

/** A stored ISRC with its separators: `USDMO2600001` → `US-DMO-26-00001`. */
export function formatIsrc(isrc: string): string {
  const parts = /^([A-Z0-9]{2})([A-Z0-9]{3})(\d{2})(\d{5})$/.exec(isrc);
  return parts ? parts.slice(1).join('-') : isrc;
}

/** A stored ISWC with its separators: `T9000000010` → `T-900.000.001-0`. */
export function formatIswc(iswc: string): string {
  const parts = /^T(\d{3})(\d{3})(\d{3})(\d)$/.exec(iswc);
  return parts ? `T-${parts[1]}.${parts[2]}.${parts[3]}-${parts[4]}` : iswc;
}

/** Milliseconds as m:ss, down to the whole second: `42000` → `0:42`. */
export function formatPlaybackTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Why an input is refused: its shape, or a check digit that does not match (§4.4). */
export type IdentifierError = {
  code: 'INVALID_ISRC' | 'INVALID_ISWC' | 'INVALID_UPC_EAN';
  reason: 'shape' | 'check_digit';
};

/** The value to store, or the refusal, shaped like a ServiceResult. */
export type IdentifierResult = { ok: true; value: string } | { ok: false; error: IdentifierError };

const refuse = (
  code: IdentifierError['code'],
  reason: IdentifierError['reason'],
): IdentifierResult => ({ ok: false, error: { code, reason } });

/**
 * An ISRC as `recordings.isrc` stores it (§4.2): hyphens and spaces removed and uppercased, then five
 * letters or digits and seven digits. An ISRC has no check digit.
 */
export function normalizeIsrc(input: string): IdentifierResult {
  const compact = input.replace(/[\s-]/g, '');
  if (!/^[A-Za-z0-9]{5}[0-9]{7}$/.test(compact)) return refuse('INVALID_ISRC', 'shape');
  return { ok: true, value: compact.toUpperCase() };
}

/**
 * An ISWC as `compositions.iswc` stores it (§4.2), from `T-123.456.789-C` or `T1234567890` in either
 * case. The check digit is tested only on a new or changed value (melos-rpr D-2): an input that
 * normalizes to `stored`, the value the row holds now, passes on its shape.
 */
export function normalizeIswc(
  input: string,
  { stored }: { stored?: string | null } = {},
): IdentifierResult {
  const compact = input.replace(/[\s.-]/g, '');
  if (!/^[Tt][0-9]{10}$/.test(compact)) return refuse('INVALID_ISWC', 'shape');
  const value = compact.toUpperCase();
  if (value !== stored && Number(value[10]) !== iswcCheckDigit(value.slice(1, 10))) {
    return refuse('INVALID_ISWC', 'check_digit');
  }
  return { ok: true, value };
}

/**
 * A UPC/EAN as `releases.upc_ean` stores it (melos-rpr D-1): hyphens and spaces removed, then 12
 * digits (UPC) or 13 (EAN) ending in the GS1 check digit. The value stays a string, so leading zeros
 * survive.
 */
export function normalizeUpcEan(input: string): IdentifierResult {
  const value = input.replace(/[\s-]/g, '');
  if (!/^[0-9]{12,13}$/.test(value)) return refuse('INVALID_UPC_EAN', 'shape');
  if (Number(value[value.length - 1]) !== gs1CheckDigit(value.slice(0, -1))) {
    return refuse('INVALID_UPC_EAN', 'check_digit');
  }
  return { ok: true, value };
}

/**
 * The ISO 15707 check digit of the nine work digits d₁…d₉: (10 − (1 + Σ i·dᵢ) mod 10) mod 10.
 * Source: https://en.wikipedia.org/wiki/International_Standard_Musical_Work_Code (UNIMARC, IFLA 2009)
 */
function iswcCheckDigit(digits: string): number {
  const sum = [...digits].reduce((total, digit, index) => total + (index + 1) * Number(digit), 1);
  return (10 - (sum % 10)) % 10;
}

/**
 * The GS1 mod-10 check digit: weights 3 and 1 alternate leftward from the last digit given, and the
 * check digit brings the sum up to a multiple of ten.
 * Source: https://www.gs1us.org/content/dam/gs1us/documents/tools-resources/check-digit-calculator/How-to-Calculate-a-Check-Digit.pdf
 */
function gs1CheckDigit(digits: string): number {
  const sum = [...digits]
    .reverse()
    .reduce((total, digit, index) => total + (index % 2 === 0 ? 3 : 1) * Number(digit), 0);
  return (10 - (sum % 10)) % 10;
}
