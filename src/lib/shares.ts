/** A share or total in basis points (§1.4) as a percentage with two decimals: 8500 → `85.00%`. */
export const formatShare = (bp: number) => `${(bp / 100).toFixed(2)}%`;
