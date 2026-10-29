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
