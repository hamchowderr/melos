/**
 * Display formats for stored identifiers and times (docs/CONTRACT.md §2.6). Display only: nothing
 * here validates, and a value in any other shape comes back unchanged.
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
