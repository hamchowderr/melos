/**
 * ISRC lookup DTOs (docs/CONTRACT.md IMP-016). Types only, with no server import, so client
 * components can import them. A suggestion is never written by the lookup: the user accepts it
 * through the normal catalog services.
 */

export const LOOKUP_SOURCES = ['musicbrainz', 'deezer'] as const;
export type LookupSource = (typeof LOOKUP_SOURCES)[number];

/** found: the source knows the ISRC. not_found: it answered and does not. unavailable: no answer. */
export type LookupSourceStatus = 'found' | 'not_found' | 'unavailable';

/** One suggested value, with where it came from so the user can check it before accepting. */
export type LookupSuggestion = { source: LookupSource; sourceUrl: string } & (
  | { field: 'title' | 'releaseTitle' | 'releaseDate' | 'label'; value: string }
  | { field: 'primaryArtistNames'; value: string[] }
  | { field: 'durationMs'; value: number }
  /** Normalized as `releases.upc_ean` and `compositions.iswc` store them; invalid codes are dropped. */
  | { field: 'upc' | 'iswc'; value: string }
  /** A PRO work ID for a `pro` composition registration; `societyCode` names the society. */
  | { field: 'proWorkCode'; value: string; societyCode: string }
);

export type IsrcLookupDTO = {
  isrc: string;
  sources: Record<LookupSource, LookupSourceStatus>;
  suggestions: LookupSuggestion[];
};
