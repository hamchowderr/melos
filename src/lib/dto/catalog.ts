/**
 * Catalog DTOs (docs/CONTRACT.md §3.4, §3.5; D-12). Types only, with no server import, so client
 * components can import them.
 */

import type { RecordingReadiness, RightsSummaryDTO } from './rights';

export type CatalogFocus = { entityType: 'composition' | 'recording'; entityId: string };

/**
 * One song in the catalog list (CAT-009, §3.5): a live composition with its live recordings, or a
 * live recording without a composition, whose `compositionId` is null. Fields follow
 * MusicSearchResult minus `matchType` and `recordingIds`; the flags are the §6.5 readiness.
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
    oneStopReady: boolean;
    syncReady: boolean;
  }[];
};

/** How a search result matched (§3.4): its normalized title, an alternate title, or the text index. */
export type MatchType = 'exact_title' | 'exact_alt_title' | 'text';

/** MusicSearchResult (§3.4): one song (§3.5), with how it matched and its recording ids. */
export type MusicSearchResult = SongListItem & { recordingIds: string[]; matchType: MatchType };

/** The searchMusic `readiness` filter (§3.3): a song passes when one live recording does. */
export const READINESS_FILTERS = [
  'one_stop_ready',
  'not_one_stop_ready',
  'sync_ready',
  'not_sync_ready',
] as const;

/** searchMusic input (§3.3); `termIds` keeps songs carrying every listed term. */
export type MusicSearchInput = {
  query: string;
  limit?: number;
  readiness?: (typeof READINESS_FILTERS)[number];
  artistPartyId?: string;
  termIds?: string[];
};

export type CompositionDTO = {
  id: string;
  title: string;
  altTitles: string[];
  iswc: string | null;
  copyrightRegistrationNumber: string | null;
  copyrightDate: string | null;
  description: string | null;
  hasLyrics: boolean;
};

export type RecordingLinkDTO = {
  id: string;
  linkType: string;
  label: string | null;
  url: string;
  isPrimary: boolean;
};

/** `displayName` is the credited artist alias when the row names one, else the party's name. */
export type RecordingArtistDTO = {
  partyId: string;
  artistAliasId: string | null;
  displayName: string;
  role: string;
  billingOrder: number;
};

export type RecordingContributorDTO = {
  partyId: string;
  displayName: string;
  role: string;
  creditText: string | null;
};

export type MetadataTermDTO = { id: string; termType: string; label: string };

export type RecordingDTO = {
  id: string;
  title: string;
  versionTitle: string | null;
  isrc: string | null;
  durationMs: number | null;
  bpm: number | null;
  musicalKey: string | null;
  previewStartMs: number | null;
  primaryLink: RecordingLinkDTO | null;
  links: RecordingLinkDTO[];
  artists: RecordingArtistDTO[];
  contributors: RecordingContributorDTO[];
  terms: MetadataTermDTO[];
};

/** A track of a live release that holds one of the song's recordings. */
export type SongReleaseDTO = {
  id: string;
  title: string;
  releaseType: string | null;
  upcEan: string | null;
  releaseDate: string | null;
  recordingId: string;
  discNumber: number;
  trackNumber: number | null;
};

/** The catalog part of MusicWorkspaceDTO (§3.4), without rights, readiness and pitchSummary. */
export type SongCatalogDTO = {
  focus: CatalogFocus;
  composition: CompositionDTO | null;
  primaryRecordingId: string | null;
  recordings: RecordingDTO[];
  releases: SongReleaseDTO[];
};

/** `pitch_items.current_status` codes (§6.4). */
export type PitchStatus =
  | 'draft'
  | 'not_contacted'
  | 'sent'
  | 'awaiting_reply'
  | 'responded'
  | 'interested'
  | 'requested_more'
  | 'passed'
  | 'accepted'
  | 'closed_won'
  | 'closed_lost'
  | 'archived';

/**
 * The pitch cells on a song's composition or on one of its live recordings (§3.4, §3.7, D-6).
 * `countsByStatus` holds only statuses with cells. `lastActivityAt` is the latest event on those
 * cells or on their pitches with no cell named; null when there is none.
 */
export type SongPitchSummaryDTO = {
  itemCount: number;
  countsByStatus: Partial<Record<PitchStatus, number>>;
  lastActivityAt: string | null;
};

/**
 * getMusicWorkspace's output (§3.3, §3.4): the catalog part with the song's rights, readiness per
 * live recording (§6.5) and pitch summary. `importedReportTemplateId` is null until phase 10.
 */
export type MusicWorkspaceDTO = SongCatalogDTO & {
  rights: RightsSummaryDTO;
  readiness: ({ recordingId: string } & Omit<RecordingReadiness, 'licensingContacts'>)[];
  pitchSummary: SongPitchSummaryDTO;
  importedReportTemplateId: string | null;
};
