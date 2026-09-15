import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ONE_STOP_CODES, SYNC_ONLY_CODES, WARNING_CODES } from '../../src/lib/dto/rights';
import {
  evaluateRecordingReadiness,
  type RecordingReadinessFacts as Facts,
  type ShareFact,
} from '../../src/server/services/rights/readiness';

type Composition = NonNullable<Facts['composition']>;
const ALL_CODES: string[] = [...ONE_STOP_CODES, ...SYNC_ONLY_CODES, ...WARNING_CODES];
const WARNINGS: readonly string[] = WARNING_CODES;
const SELF = { partyId: 'pty_SELF', displayName: 'Silverline Songs' };
const OTHER = { partyId: 'pty_OTHER', displayName: 'Nightshift Audio' };
const holder = (partyId: string, shareBp: number, attested: unknown = false): ShareFact => ({
  partyId,
  shareBp,
  representationAttested: Boolean(attested),
});
const own = (shareBp = 10000) => holder(SELF.partyId, shareBp);
const other = (shareBp: number, attested = false) => holder(OTHER.partyId, shareBp, attested);
const pub = (...sets: [string, ShareFact[]][]) =>
  sets.map(([territory, holders]) => ({ territory, holders }));
const SONG: Composition = {
  id: 'cmp_A',
  iswc: 'T9000000010',
  writers: [{ shareBp: 10000 }],
  publishing: pub(['WORLD', [own()]]),
};
/** A one-stop and sync ready recording with `change` applied: the self parties hold every share. */
const facts = (change: Partial<Facts> = {}): Facts => ({
  recordingId: 'rec_A',
  isrc: 'USDMO2600001',
  hasPrimaryLink: true,
  selfParties: { publishing: SELF, master: SELF },
  composition: SONG,
  masters: [own()],
  licensingContacts: [],
  ...change,
});
const song = (change: Partial<Composition>) => facts({ composition: { ...SONG, ...change } });
const codesOf = (input: Facts) =>
  evaluateRecordingReadiness(input)
    .issues.map((issue) => issue.code)
    .join(' ');

/** Expected codes, in order, for facts that break one rule. */
const CASES: [string, Facts][] = [
  ['NO_COMPOSITION', facts({ composition: null })],
  ['WRITER_TOTAL_INCOMPLETE', song({ writers: [{ shareBp: 5000 }, { shareBp: null }] })],
  ['WRITER_TOTAL_OVER', song({ writers: [{ shareBp: 10000 }, { shareBp: 1 }] })],
  ['PUBLISHING_TOTAL_INCOMPLETE', song({ publishing: [] })],
  ['PUBLISHING_TOTAL_OVER', song({ publishing: pub(['WORLD', [own(), other(500)]]) })],
  ['PUBLISHING_TERRITORY_MIXED', song({ publishing: pub(['WORLD', [own()]], ['US', [own()]]) })],
  ['MASTER_TOTAL_INCOMPLETE MASTER_NOT_CONTROLLED NO_LICENSING_CONTACT', facts({ masters: [] })],
  ['MASTER_TOTAL_OVER', facts({ masters: [own(), other(2500)] })],
  [
    'SELF_PARTY_NOT_CONFIGURED PUBLISHING_NOT_CONTROLLED NO_LICENSING_CONTACT',
    facts({ selfParties: { publishing: null, master: SELF } }),
  ],
  [
    'SELF_PARTY_NOT_CONFIGURED MASTER_NOT_CONTROLLED NO_LICENSING_CONTACT',
    facts({ selfParties: { publishing: SELF, master: null } }),
  ],
  // §6.5: with no master self party there is no implicit contact, even when every row is attested.
  [
    'SELF_PARTY_NOT_CONFIGURED NO_LICENSING_CONTACT',
    facts({ selfParties: { publishing: SELF, master: null }, masters: [other(10000, true)] }),
  ],
  [
    'PUBLISHING_NOT_CONTROLLED NO_LICENSING_CONTACT',
    song({ publishing: pub(['GB', [own()]], ['US', [own(5000), other(5000)]]) }),
  ],
  ['MASTER_NOT_CONTROLLED NO_LICENSING_CONTACT', facts({ masters: [other(10000)] })],
  ['MISSING_ISRC', facts({ isrc: null })],
  ['NO_LISTEN_LINK', facts({ hasPrimaryLink: false })],
  ['MISSING_ISWC', song({ iswc: null })],
];

describe('evaluateRecordingReadiness (§6.5)', () => {
  it('lists every code in §6.5 order, as validate.mjs does, with a focused case each', () => {
    const contract = readFileSync('docs/CONTRACT.md', 'utf8');
    const section = contract.split('### 6.5 ')[1].split('\n### ')[0];
    const lines = section.match(/^\| `[A-Z_]+`(?: \/ `[A-Z_]+`)? \||^Warning only.*$/gm) ?? [];
    const listed = lines.flatMap((line) => line.match(/`[A-Z][A-Z_]{3,}`/g) ?? []);
    expect(listed.map((code) => code.slice(1, -1))).toEqual(ALL_CODES);
    const script = readFileSync('docs/fixtures/validate.mjs', 'utf8');
    const reference = [...script.matchAll(/\[\s*'(blocking|sync|warning)',\s*'([A-Z_]+)'/g)];
    const kinds = { blocking: ONE_STOP_CODES, sync: SYNC_ONLY_CODES, warning: WARNING_CODES };
    const want = Object.entries(kinds).flatMap(([kind, codes]) => codes.map((c) => `${kind} ${c}`));
    expect(reference.map((m) => `${m[1]} ${m[2]}`)).toEqual(want);
    expect(new Set(CASES.flatMap(([codes]) => codes.split(' ')))).toEqual(new Set(ALL_CODES));
  });

  it.each(CASES)('%s', (codes, input) => {
    const result = evaluateRecordingReadiness(input);
    expect(codesOf(input)).toBe(codes);
    const blocks = (list: readonly string[]) => codes.split(' ').some((c) => list.includes(c));
    expect(result.oneStopReady).toBe(!blocks(ONE_STOP_CODES));
    expect(result.syncReady).toBe(!blocks(ONE_STOP_CODES) && !blocks(SYNC_ONLY_CODES));
    const severity = (code: string) => (WARNINGS.includes(code) ? 'warning' : 'blocking');
    expect(result.issues.map((i) => [i.severity, i.recordingId, i.compositionId])).toEqual(
      codes.split(' ').map((c) => [severity(c), 'rec_A', input.composition && 'cmp_A']),
    );
  });

  it('gives the same issues and details whatever the input order', () => {
    const publishing = pub(['WORLD', [other(9000)]], ['US', [own(6000), other(6000)]]);
    const result = evaluateRecordingReadiness(song({ publishing }));
    expect(evaluateRecordingReadiness(song({ publishing: [...publishing].reverse() }))).toEqual(
      result,
    );
    expect(result.issues.map((issue) => `${issue.code}: ${issue.detail}`)).toEqual([
      'PUBLISHING_TOTAL_INCOMPLETE: Publishing WORLD 9000 bp.',
      'PUBLISHING_TOTAL_OVER: Publishing US 12000 bp.',
      'PUBLISHING_TERRITORY_MIXED: Publishing mixes a WORLD set with country sets.',
      'PUBLISHING_NOT_CONTROLLED: Controlled publishing US 6000 bp, WORLD 0 bp.',
      'NO_LICENSING_CONTACT: No licensing contact.',
    ]);
  });

  it('counts an attested row as controlled on both sides', () => {
    const publishing = pub(['WORLD', [own(6000), other(4000, true)]]);
    const attested = { ...song({ publishing }), masters: [other(10000, true)] };
    expect(codesOf(attested)).toBe('');
    const unattested = { ...attested, masters: [other(10000)] };
    expect(codesOf(unattested)).toBe('MASTER_NOT_CONTROLLED NO_LICENSING_CONTACT');
  });

  it('names the master self party as implicit contact unless explicit contacts exist', () => {
    expect(evaluateRecordingReadiness(facts())).toEqual({
      oneStopReady: true,
      syncReady: true,
      issues: [],
      licensingContacts: [{ ...SELF, implicit: true }],
    });
    const named = evaluateRecordingReadiness(facts({ licensingContacts: [SELF, OTHER, SELF] }));
    expect(named.licensingContacts).toEqual([OTHER, SELF].map((p) => ({ ...p, implicit: false })));
    const uncontrolled = facts({ licensingContacts: [OTHER], masters: [other(10000)] });
    expect(codesOf(uncontrolled)).toBe('MASTER_NOT_CONTROLLED');
  });
});

/** The northstar-demo.json columns the facts read. */
type Row = Record<'id' | 'side' | 'territory' | 'title' | 'display_name' | `${string}_id`, string> &
  Record<'isrc' | 'iswc' | 'deleted_at' | 'representation_attested_at', string | null> &
  Record<'share_bp' | 'writer_share_bp' | 'is_primary', number>;
const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const keyOf = new Map(Object.entries<string>(fixture.keys).map(([key, id]) => [id, key]));
const rows = (table: string, column: keyof Row, value: string | null): Row[] =>
  (fixture.workspace[table] ?? []).filter((row: Row) => row[column] === value);
const party = (p: string) => ({
  partyId: p,
  displayName: rows('parties', 'id', p)[0].display_name,
});
const selfParty = (side: string) =>
  rows('workspace_self_parties', 'side', side).map((s) => party(s.party_id))[0] ?? null;

/** Facts for a Northstar recording, from the fixture's live rows as RightsService reads them. */
function northstarFacts(recording: Row): Facts {
  const cmp = rows('compositions', 'id', recording.composition_id).find((c) => !c.deleted_at);
  const publishing = cmp ? rows('publishing_interests', 'composition_id', cmp.id) : [];
  const share = (row: Row, partyId: string) =>
    holder(partyId, row.share_bp, row.representation_attested_at);
  return {
    recordingId: recording.id,
    isrc: recording.isrc,
    hasPrimaryLink: rows('recording_links', 'recording_id', recording.id).some((l) => l.is_primary),
    selfParties: { publishing: selfParty('publishing'), master: selfParty('master') },
    composition: cmp
      ? {
          id: cmp.id,
          iswc: cmp.iswc,
          writers: rows('composition_contributors', 'composition_id', cmp.id).map((w) => ({
            shareBp: w.writer_share_bp,
          })),
          publishing: [...new Set(publishing.map((p) => p.territory))].map((territory) => ({
            territory,
            holders: publishing
              .filter((p) => p.territory === territory)
              .map((p) => share(p, p.publisher_party_id)),
          })),
        }
      : null,
    masters: rows('master_interests', 'recording_id', recording.id).map((m) =>
      share(m, m.owner_party_id),
    ),
    licensingContacts: [
      ...rows('licensing_contacts', 'recording_id', recording.id),
      ...(cmp ? rows('licensing_contacts', 'composition_id', cmp.id) : []),
    ].map((l) => party(l.party_id)),
  };
}

describe('Northstar readiness (EXPECTED.md §2)', () => {
  it('reproduces the readiness table for the five songs', () => {
    const md = readFileSync('docs/fixtures/EXPECTED.md', 'utf8').replace(/\r\n/g, '\n');
    const lines = md.split('<!-- check:readiness -->\n')[1].split('\n\n')[0].split('\n').slice(2);
    const cells = (line: string) =>
      line
        .replace(/`/g, '')
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
    const list = (items: string[]) => items.join(', ') || 'none';
    const actual = rows('recordings', 'deleted_at', null).map((recording) => {
      const result = evaluateRecordingReadiness(northstarFacts(recording));
      const codes = (from: readonly string[]) =>
        list(result.issues.map((i) => i.code).filter((code) => from.includes(code)));
      const contacts = result.licensingContacts.map(
        (c) => `${keyOf.get(c.partyId)}${c.implicit ? ' (implicit)' : ''}`,
      );
      const flags = [result.oneStopReady, result.syncReady].map(String);
      const lists = [ONE_STOP_CODES, SYNC_ONLY_CODES, WARNING_CODES].map(codes);
      return [recording.title, keyOf.get(recording.id), ...lists, ...flags, list(contacts)];
    });
    expect(lines).toHaveLength(5);
    expect(actual).toEqual(lines.map(cells));
  });
});
