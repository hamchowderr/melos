import {
  type LicensingContactDTO,
  ONE_STOP_CODES,
  type ReadinessCode,
  type RecordingReadiness,
  SYNC_ONLY_CODES,
  WARNING_CODES,
} from '../../../lib/dto/rights';

/** 100% in basis points (§1.4). */
const FULL_BP = 10000;

/** Codes that rule out the implicit contact: no composition, an incomplete side, or partial control. */
const NOT_FULL_CONTROL: readonly ReadinessCode[] = [
  'NO_COMPOSITION',
  'PUBLISHING_TOTAL_INCOMPLETE',
  'PUBLISHING_TOTAL_OVER',
  'MASTER_TOTAL_INCOMPLETE',
  'MASTER_TOTAL_OVER',
  'PUBLISHING_NOT_CONTROLLED',
  'MASTER_NOT_CONTROLLED',
];

export type PartyFact = { partyId: string; displayName: string };
/** A publishing or master row, with the RightsSummaryDTO holder fields readiness reads. */
export type ShareFact = { partyId: string; shareBp: number; representationAttested: boolean };

/** What §6.5 reads for one live recording, from live rows (RightsService loads it). */
export type RecordingReadinessFacts = {
  recordingId: string;
  isrc: string | null;
  /** A `recording_links` row of the recording has `is_primary = 1`. */
  hasPrimaryLink: boolean;
  /** RGT-010: `contains_samples` and `samples_cleared`, a registered SoundExchange row, an
   * `instrumental` asset, and a live exclusive agreement with an outside counterparty. */
  containsSamples: boolean;
  samplesCleared: boolean;
  registeredSoundExchange: boolean;
  hasInstrumental: boolean;
  exclusiveAgreement: boolean;
  /** `workspace_self_parties` for sides publishing and master; null when the side is not set. */
  selfParties: { publishing: PartyFact | null; master: PartyFact | null };
  /** Null for a recording without a composition. */
  composition: {
    id: string;
    iswc: string | null;
    /** A registered `composition_registrations` row of kind `pro` / `mlc` (RGT-010). */
    registeredPro: boolean;
    registeredMlc: boolean;
    /** One entry per `composition_contributors` row; a NULL share counts as 0, as in the view. */
    writers: { shareBp: number | null }[];
    /** `publishing_interests`, one entry per territory. */
    publishing: { territory: string; holders: ShareFact[] }[];
  } | null;
  masters: ShareFact[];
  /** Parties of the `licensing_contacts` rows that target the recording or its composition. */
  licensingContacts: PartyFact[];
};

type SetTotals = { territory: string; total: number; controlled: number };
const sum = (shares: { shareBp: number | null }[]) =>
  shares.reduce((total, share) => total + (share.shareBp ?? 0), 0);
/** Share held by the self party or by a row with an attested representation (§6.5). */
const controlled = (holders: ShareFact[], self: PartyFact | null) =>
  sum(holders.filter((h) => h.partyId === self?.partyId || h.representationAttested));
const listed = (sets: SetTotals[], key: 'total' | 'controlled') =>
  sets.map((set) => `${set.territory} ${set[key]} bp`).join(', ');
const contact =
  (implicit: boolean) =>
  ({ partyId, displayName }: PartyFact): LicensingContactDTO => ({
    partyId,
    displayName,
    implicit,
  });

/**
 * Derives one recording's one-stop and sync readiness by the §6.5 rules with P-04 and P-28. Pure:
 * the same facts give the same result, with issues in §6.5 table order.
 */
export function evaluateRecordingReadiness(facts: RecordingReadinessFacts): RecordingReadiness {
  const { composition, selfParties, masters } = facts;
  const found = new Map<ReadinessCode, string>();
  const flag = (code: ReadinessCode, applies: boolean, detail: string) =>
    applies && found.set(code, detail);

  const sets: SetTotals[] = (composition?.publishing ?? [])
    .map(({ territory, holders }) => ({
      territory,
      total: sum(holders),
      controlled: controlled(holders, selfParties.publishing),
    }))
    .sort((a, b) => (a.territory < b.territory ? -1 : 1));
  const under = sets.filter((set) => set.total < FULL_BP);
  const over = sets.filter((set) => set.total > FULL_BP);
  const uncontrolled = sets.filter((set) => set.controlled < FULL_BP);
  const noSets = composition !== null && sets.length === 0;
  const world = sets.filter((set) => set.territory === 'WORLD').length;
  const writers = composition ? sum(composition.writers) : FULL_BP;
  const master = sum(masters);
  const ownMaster = controlled(masters, selfParties.master);
  const unset = (['publishing', 'master'] as const).filter((side) => !selfParties[side]);

  flag('NO_COMPOSITION', !composition, 'The recording has no composition.');
  flag('WRITER_TOTAL_INCOMPLETE', writers < FULL_BP, `Writer shares total ${writers} bp.`);
  flag('WRITER_TOTAL_OVER', writers > FULL_BP, `Writer shares total ${writers} bp.`);
  const publishingUnder = noSets ? 'No publishing rows.' : `Publishing ${listed(under, 'total')}.`;
  flag('PUBLISHING_TOTAL_INCOMPLETE', noSets || under.length > 0, publishingUnder);
  flag('PUBLISHING_TOTAL_OVER', over.length > 0, `Publishing ${listed(over, 'total')}.`);
  const mixed = world > 0 && world < sets.length;
  flag('PUBLISHING_TERRITORY_MIXED', mixed, 'Publishing mixes a WORLD set with country sets.');
  flag('MASTER_TOTAL_INCOMPLETE', master < FULL_BP, `Master shares total ${master} bp.`);
  flag('MASTER_TOTAL_OVER', master > FULL_BP, `Master shares total ${master} bp.`);
  flag('SELF_PARTY_NOT_CONFIGURED', unset.length > 0, `No self party for ${unset.join(' or ')}.`);
  const publishingControlled = `Controlled publishing ${listed(uncontrolled, 'controlled')}.`;
  flag('PUBLISHING_NOT_CONTROLLED', uncontrolled.length > 0, publishingControlled);
  flag('MASTER_NOT_CONTROLLED', ownMaster < FULL_BP, `Controlled master ${ownMaster} bp.`);

  // P-28: explicit contacts win; otherwise the master self party, only at 100% of both sides.
  const explicit = [...new Map(facts.licensingContacts.map((p) => [p.partyId, p])).values()];
  const partial = NOT_FULL_CONTROL.some((code) => found.has(code));
  const implicit = !partial && selfParties.master ? [selfParties.master] : [];
  const licensingContacts = explicit.length
    ? explicit.sort((a, b) => (a.partyId < b.partyId ? -1 : 1)).map(contact(false))
    : implicit.map(contact(true));
  flag('NO_LICENSING_CONTACT', licensingContacts.length === 0, 'No licensing contact.');

  flag('MISSING_ISRC', facts.isrc === null, 'The recording has no ISRC.');
  flag('NO_LISTEN_LINK', !facts.hasPrimaryLink, 'The recording has no primary listen link.');
  const uncleared = facts.containsSamples && !facts.samplesCleared;
  flag('SAMPLES_NOT_CLEARED', uncleared, 'The recording has samples that are not cleared.');
  flag('MISSING_ISWC', composition?.iswc === null, 'The composition has no ISWC.');
  const pro = composition?.registeredPro === false;
  flag('NOT_REGISTERED_PRO', pro, 'The composition is not registered with a PRO.');
  const mlc = composition?.registeredMlc === false;
  flag('NOT_REGISTERED_MLC', mlc, 'The composition is not registered with The MLC.');
  const soundExchange = !facts.registeredSoundExchange;
  flag('NOT_REGISTERED_SOUNDEXCHANGE', soundExchange, 'Not registered with SoundExchange.');
  flag('NO_INSTRUMENTAL', !facts.hasInstrumental, 'The recording has no instrumental.');
  const exclusive = 'An exclusive agreement with another party covers this song.';
  flag('EXCLUSIVE_AGREEMENT', facts.exclusiveAgreement, exclusive);

  const ids = { recordingId: facts.recordingId, compositionId: composition?.id ?? null };
  const issues = (codes: readonly ReadinessCode[], severity: 'blocking' | 'warning') =>
    codes
      .filter((code) => found.has(code))
      .map((code) => ({ code, severity, ...ids, detail: found.get(code) ?? '' }));
  const blocking = issues(ONE_STOP_CODES, 'blocking');
  const syncOnly = issues(SYNC_ONLY_CODES, 'blocking');
  return {
    oneStopReady: blocking.length === 0,
    syncReady: blocking.length === 0 && syncOnly.length === 0,
    issues: [...blocking, ...syncOnly, ...issues(WARNING_CODES, 'warning')],
    licensingContacts,
  };
}
