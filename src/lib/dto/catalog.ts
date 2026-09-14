/**
 * Catalog DTOs (docs/CONTRACT.md §3.4, §3.5; D-12). Types only, with no server import, so client
 * components can import them.
 */

export type CatalogFocus = { entityType: 'composition' | 'recording'; entityId: string };

/**
 * One song in the catalog list (CAT-009, §3.5): a live composition with its live recordings, or a
 * live recording without a composition, whose `compositionId` is null. Fields follow
 * MusicSearchResult without search and readiness.
 */
export type SongListItem = {
  compositionId: string | null;
  primaryRecordingId: string | null;
  title: string;
  altTitles: string[];
  primaryArtistNames: string[];
  iswc: string | null;
  recordings: {
    recordingId: string;
    title: string;
    versionTitle: string | null;
    isrc: string | null;
  }[];
};
