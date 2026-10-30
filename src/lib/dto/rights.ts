/**
 * Rights readiness DTOs (docs/CONTRACT.md §3.4, §6.5; D-12). Types and the §6.5 code lists, with no
 * server import, so client components can import them.
 */
import type { SelfPartiesDTO, SelfPartySide } from './self-parties';

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
export const SYNC_ONLY_CODES = ['MISSING_ISRC', 'NO_LISTEN_LINK', 'SAMPLES_NOT_CLEARED'] as const;

/** Codes that never block (§6.5). */
export const WARNING_CODES = [
  'MISSING_ISWC',
  'NOT_REGISTERED_PRO',
  'NOT_REGISTERED_MLC',
  'NOT_REGISTERED_SOUNDEXCHANGE',
  'NO_INSTRUMENTAL',
  'EXCLUSIVE_AGREEMENT',
] as const;

type CodeLists = typeof ONE_STOP_CODES | typeof SYNC_ONLY_CODES | typeof WARNING_CODES;
export type ReadinessCode = CodeLists[number];

/**
 * One §6.5 finding for a recording. One-stop and sync-only codes are both `blocking`; the code
 * lists above tell them apart (PROPOSED P-42). `compositionId` is null for NO_COMPOSITION.
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

/** A publishing or master row in RightsSummaryDTO; `isSelf` compares with its side's self party. */
export type RightsHolderDTO = {
  interestId: string;
  partyId: string;
  displayName: string;
  shareBp: number;
  isSelf: boolean;
  representationAttested: boolean;
  agreementId: string | null;
};

/** One song's shares with the §4.3 view totals, its licensing contacts and its issues (§3.4). */
export type RightsSummaryDTO = {
  /** Null for a recording without a composition, which has no writer or publishing side. */
  compositionId: string | null;
  writers: {
    contributorId: string;
    partyId: string;
    displayName: string;
    roles: string[];
    shareBp: number | null;
  }[];
  writerTotalBp: number;
  /** One entry per territory. */
  publishing: { territory: string; totalBp: number; holders: RightsHolderDTO[] }[];
  /** One entry per live recording. */
  masters: { recordingId: string; totalBp: number; holders: RightsHolderDTO[] }[];
  licensingContacts: LicensingContactDTO[];
  /** Every live recording's issues, recording by recording. */
  issues: ReadinessIssue[];
};

/** The `agreements.agreement_type` values the §4.3 CHECK allows. */
export const AGREEMENT_TYPES = [
  'publishing',
  'master',
  'representation',
  'licensing',
  'other',
] as const;

export type AgreementType = (typeof AGREEMENT_TYPES)[number];

/**
 * An `agreements` row (§4.3) with its counterparty's display name. PROPOSED (melos-rpr.15): §3.3 and
 * §3.4 define no agreement tool or DTO. Dates are `YYYY-MM-DD` (§1.4).
 */
export type AgreementDTO = {
  id: string;
  agreementType: AgreementType;
  title: string;
  counterpartyPartyId: string | null;
  counterpartyName: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  /** RGT-009: an exclusive agreement and its scope in free text, such as "sync, worldwide". */
  isExclusive: boolean;
  exclusivityScope: string | null;
  assetId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

/** createAgreement input (PROPOSED). An omitted optional field is stored as NULL. */
export type AgreementInput = {
  agreementType: AgreementType;
  title: string;
  counterpartyPartyId?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  /** RGT-009; defaults to false. */
  isExclusive?: boolean;
  exclusivityScope?: string | null;
  assetId?: string | null;
  notes?: string | null;
};

/** updateAgreement patch (PROPOSED): an omitted field keeps its value; null clears a nullable one. */
export type AgreementPatch = Partial<AgreementInput>;

/** listAgreements filter (PROPOSED). */
export type AgreementFilter = { agreementType?: AgreementType; counterpartyPartyId?: string };

/** Recordings with both readiness flags and their issues (§3.4). */
export type ReadinessReportDTO = {
  generatedAt: string;
  recordings: ({ recordingId: string; compositionId: string | null; title: string } & Omit<
    RecordingReadiness,
    'licensingContacts'
  >)[];
};

/** attestRepresentation input (§3.3): `attested` true sets the attestation, false clears it. */
export type RepresentationInput = {
  interestType: 'publishing' | 'master';
  interestId: string;
  agreementId?: string | null;
  attested: boolean;
};

/** One licensing contact in updateLicensingContacts input (§3.3). */
export type LicensingContactInput = {
  partyId: string;
  agreementId?: string | null;
  notes?: string | null;
};

/** updateLicensingContacts input (§3.3): exactly one target, and the contact set that replaces it. */
export type LicensingContactsInput = {
  recordingId?: string;
  compositionId?: string;
  contacts: LicensingContactInput[];
};

export const WRITER_ROLES = ['songwriter', 'composer', 'lyricist', 'arranger'] as const;

/** One writer in a composition's whole share set (§4.4 share replacement, RGT-001). */
export type WriterShareInput = {
  partyId: string;
  roles: (typeof WRITER_ROLES)[number][];
  shareBp: number | null;
};

/**
 * A writer share-set replace. `expectedBeforeHash`, from an approval request (§7.4), refuses with
 * STATE_CHANGED when the current set no longer hashes to it.
 */
export type WriterSharesInput = {
  compositionId: string;
  shares: WriterShareInput[];
  expectedBeforeHash?: string;
};

/** One holder in a publishing or master share set (RGT-002, RGT-003), keyed by party. */
export type HolderShareInput = { partyId: string; shareBp: number; agreementId?: string | null };

/**
 * A publishing share-set replace for one territory (RGT-007, P-05): 'WORLD' or an ISO 3166-1
 * alpha-2 code, never both for one composition.
 */
export type PublishingSharesInput = {
  compositionId: string;
  territory: string;
  shares: HolderShareInput[];
  expectedBeforeHash?: string;
};

/** A master share-set replace for one recording (RGT-003). */
export type MasterSharesInput = {
  recordingId: string;
  shares: HolderShareInput[];
  expectedBeforeHash?: string;
};

/** Why a side of a DefaultOwnershipProposal is null (RGT-008, PROPOSED). */
export const OWNERSHIP_BLOCKS = ['has_rows', 'no_self_party', 'no_composition'] as const;

/**
 * Default ownership for a song's empty share sets (§3.4, RGT-008): each side's self party at 100%,
 * or null with a blocked reason when the side already has rows or has nothing to fill. Writers
 * default to songwriter and publishing to WORLD (PROPOSED). Applying it uses the share tools.
 */
export type DefaultOwnershipProposal = {
  selfParties: SelfPartiesDTO;
  writerShares: WriterShareInput[] | null;
  publishingShares: { territory: 'WORLD'; shares: HolderShareInput[] } | null;
  masterShares: { recordingId: string; shares: HolderShareInput[] }[] | null;
  blockedReasons: { side: SelfPartySide; code: (typeof OWNERSHIP_BLOCKS)[number] }[];
};
