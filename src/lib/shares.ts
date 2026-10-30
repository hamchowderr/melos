/** A share or total in basis points (§1.4) as a percentage with two decimals: 8500 → `85.00%`. */
export const formatShare = (bp: number) => `${(bp / 100).toFixed(2)}%`;

/**
 * A typed percentage with at most two decimals as basis points: `60` → 6000, `33.33` → 3333. Null
 * for anything else, such as `12.345`, `-1` or `abc`; a blank entry is null too.
 */
export function percentToBp(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
