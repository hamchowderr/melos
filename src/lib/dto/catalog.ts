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

/**
 * createComposition input (§3.3): an omitted field is stored as NULL. Alternate titles are stored as
 * `alternate`, each once (`composition_alt_titles`, §4.2).
 */
export type CompositionInput = {
  title: string;
  description?: string | null;
  lyrics?: string | null;
  iswc?: string | null;
  copyrightRegistrationNumber?: string | null;
  copyrightDate?: string | null;
  altTitles?: string[];
};

/**
 * updateComposition `patch` (§3.3): an omitted field is kept and null clears it. `altTitles`
 * replaces the set; a title it keeps keeps its `title_type`. PROPOSED (melos-rpr.13).
 */
export type CompositionPatch = Partial<Omit<CompositionInput, 'title'>> & { title?: string };

/** A live composition findCompositionDuplicates matched, and what matched (§3.3, §6.15). */
export type CompositionDuplicate = {
  compositionId: string;
  title: string;
  iswc: string | null;
  matchedOn: ('title' | 'iswc')[];
};

/** The `recording_links.link_type` values the §4.2 CHECK allows. */
export const LINK_TYPES = [
  'private_player',
  'dsp',
  'cloud_file',
  'sync_link',
  'video',
  'other',
] as const;

/** A link in a createRecording or updateRecording `links` set; at most one is primary. */
export type RecordingLinkInput = {
  url: string;
  linkType?: (typeof LINK_TYPES)[number];
  label?: string | null;
  isPrimary?: boolean;
};

/**
 * createRecording input (§3.3). An omitted optional field is stored as NULL; `links` is the whole
 * set. PROPOSED (melos-rpr.18): `copyrightDate` and the other §4.2 columns wait for MetadataPanel.
 */
export type RecordingInput = {
  compositionId?: string | null;
  title: string;
  versionTitle?: string | null;
  isrc?: string | null;
  durationMs?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  previewStartMs?: number | null;
  links?: RecordingLinkInput[];
};

/** A live recording findRecordingDuplicates matched, and what matched (§3.3, §6.15). */
export type RecordingDuplicate = {
  recordingId: string;
  compositionId: string | null;
  title: string;
  versionTitle: string | null;
  isrc: string | null;
  matchedOn: ('isrc' | 'title')[];
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

/** The `releases.release_type` values the §4.2 CHECK allows. */
export const RELEASE_TYPES = ['single', 'ep', 'album', 'compilation', 'other'] as const;

export type ReleaseType = (typeof RELEASE_TYPES)[number];

/** A `release_tracks` row (§4.2) without its release id. */
export type ReleaseTrackDTO = {
  recordingId: string;
  discNumber: number;
  trackNumber: number | null;
};

/**
 * createRelease input (§3.3): an omitted field is stored as NULL, a track's disc as 1. Tracks are
 * unique by recording and by numbered position on a disc (the release_tracks keys).
 */
export type ReleaseInput = {
  title: string;
  releaseType?: ReleaseType | null;
  upcEan?: string | null;
  labelPartyId?: string | null;
  distributorPartyId?: string | null;
  releaseDate?: string | null;
  tracks?: { recordingId: string; discNumber?: number; trackNumber?: number | null }[];
};

/**
 * updateRelease `patch` (§3.3): an omitted field is kept and null clears it; `tracks` replaces the
 * set, matched by recording. PROPOSED (melos-rpr.14).
 */
export type ReleasePatch = Partial<Omit<ReleaseInput, 'title'>> & { title?: string };

/**
 * A live `releases` row (§4.2; `deletedAt` null) with its tracks by disc and track number, unnumbered
 * last. PROPOSED (melos-rpr.14): §3.4 has no release DTO; the phase 5 tool builds MusicWorkspaceDTO.
 */
export type ReleaseDTO = Required<Omit<ReleaseInput, 'tracks'>> & {
  id: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  tracks: ReleaseTrackDTO[];
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
