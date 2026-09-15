/**
 * Rights readiness DTOs (docs/CONTRACT.md §3.4, §6.5; D-12). Types and the §6.5 code lists, with no
 * server import, so client components can import them.
 */

/** Codes that block `oneStopReady`, in the order of the §6.5 table. */
export const ONE_STOP_CODES = [
  'NO_COMPOSITION',
  'WRITER_TOTAL_INCOMPLETE',
  'WRITER_TOTAL_OVER',
  'PUBLISHING_TOTAL_INCOMPLETE',
  'PUBLISHING_TOTAL_OVER',
  'PUBLISHING_TERRITORY_MIXED',
  'MASTER_TOTAL_INCOMPLETE',
  'MASTER_TOTAL_OVER',
  'SELF_PARTY_NOT_CONFIGURED',
  'PUBLISHING_NOT_CONTROLLED',
  'MASTER_NOT_CONTROLLED',
  'NO_LICENSING_CONTACT',
] as const;

/** Codes that block only `syncReady` (P-04), in §6.5 order. */
export const SYNC_ONLY_CODES = ['MISSING_ISRC', 'NO_LISTEN_LINK'] as const;

/** Codes that never block (§6.5). */
export const WARNING_CODES = ['MISSING_ISWC'] as const;

type CodeLists = typeof ONE_STOP_CODES | typeof SYNC_ONLY_CODES | typeof WARNING_CODES;
export type ReadinessCode = CodeLists[number];

/**
 * One §6.5 finding for a recording. One-stop and sync-only codes are both `blocking`; the code
 * lists above tell them apart (G-11, PROPOSED P-42). `compositionId` is null for NO_COMPOSITION.
 */
export type ReadinessIssue = {
  code: ReadinessCode;
  severity: 'blocking' | 'warning';
  recordingId: string;
  compositionId: string | null;
  detail: string;
};

/** A `RightsSummaryDTO.licensingContacts` entry; `implicit` marks the master self party (P-28). */
export type LicensingContactDTO = { partyId: string; displayName: string; implicit: boolean };

/** One recording's readiness (§6.5): both flags, its issues in code order and its contacts. */
export type RecordingReadiness = {
  oneStopReady: boolean;
  syncReady: boolean;
  issues: ReadinessIssue[];
  licensingContacts: LicensingContactDTO[];
};
