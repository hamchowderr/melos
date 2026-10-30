import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { LocalAssetStorage } from '../../src/server/services/assets/local-asset-storage';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

/** The services whose every exported write the sweep covers (DAT-001, AUD-001). */
const MODULES = {
  artists: () => import('../../src/server/services/catalog/artists'),
  compositions: () => import('../../src/server/services/catalog/compositions'),
  deletes: () => import('../../src/server/services/catalog/deletes'),
  recordings: () => import('../../src/server/services/catalog/recordings'),
  registrations: () => import('../../src/server/services/catalog/registrations'),
  releases: () => import('../../src/server/services/catalog/releases'),
  songs: () => import('../../src/server/services/catalog/songs'),
  terms: () => import('../../src/server/services/catalog/terms'),
  aliases: () => import('../../src/server/services/contacts/aliases'),
  contacts: () => import('../../src/server/services/contacts/contacts'),
  methods: () => import('../../src/server/services/contacts/methods'),
  parties: () => import('../../src/server/services/contacts/parties'),
  agreements: () => import('../../src/server/services/rights/agreements'),
  holderShares: () => import('../../src/server/services/rights/holder-shares'),
  representation: () => import('../../src/server/services/rights/representation'),
  selfParties: () => import('../../src/server/services/rights/self-parties'),
  shares: () => import('../../src/server/services/rights/shares'),
  assets: () => import('../../src/server/services/assets/asset-service'),
};
type Modules = { [K in keyof typeof MODULES]: Awaited<ReturnType<(typeof MODULES)[K]>> };

/** A write's exported name. insert* and reindex* run inside a caller's transaction. */
const WRITE = /^(create|update|delete|set|ensure|attest|complete|add|replace)[A-Z]/;

type Result = ServiceResult<unknown>;
type Case = {
  /** The audit actions one success writes, in any order (AUD-001). */
  actions: string[];
  /** Rows the case needs that are not part of what it proves. */
  setup?: () => Promise<void>;
  run: () => Promise<Result>;
  /** A refusal that writes nothing and adds no audit row. */
  refuse: () => Promise<Result>;
};

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let s: Modules;
let owner: TenantContext;
let storage: LocalAssetStorage;
const { keys } = NORTHSTAR;
const MISSING = 'pty_01K0000000000000000000000Z';
const ids: Record<string, string> = {};

const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const auditActions = async () =>
  (
    await (
      await open()
    )
      .select({ id: tables.auditLog.id, action: tables.auditLog.action })
      .from(tables.auditLog)
  ).map(({ id, action }) => `${id} ${action}`);
/** A success's value, so later cases can use the ids it created. */
const value = async <T>(pending: Promise<ServiceResult<T>>) => {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
};
const viewer = () => withRole(owner, 'viewer');

/** Signs an upload and puts its bytes at the key, as the browser's PUT does. */
async function uploaded() {
  const input = { assetType: 'audio', fileName: 'sweep.mp3', contentType: 'audio/mpeg' } as const;
  const ticket = await value(s.assets.createUpload(owner, input));
  const storageKey = decodeURIComponent(new URL(ticket.url, 'http://x').pathname).replace(
    '/api/assets/local/',
    '',
  );
  const body = new TextEncoder().encode('ID3 sweep');
  await storage.put({
    workspaceId: owner.workspaceId,
    storageKey,
    contentType: input.contentType,
    body,
  });
  ids.asset = ticket.assetId;
}

const cases = (): Record<string, Case> => ({
  createParty: {
    actions: ['party.create'],
    run: async () => {
      const party = await value(
        s.parties.createParty(owner, { partyKind: 'person', displayName: 'Sweep Person' }),
      );
      ids.person = party.partyId;
      return { ok: true, value: party };
    },
    refuse: () => s.parties.createParty(viewer(), { partyKind: 'person', displayName: 'No' }),
  },
  updateParty: {
    actions: ['party.update'],
    run: () => s.parties.updateParty(owner, ids.person, { displayName: 'Sweep Person Two' }),
    refuse: () => s.parties.updateParty(owner, MISSING, { displayName: 'No' }),
  },
  setArtistAliases: {
    actions: ['party.update'],
    run: () =>
      s.aliases.setArtistAliases(owner, ids.person, [{ aliasName: 'SP', isPrimary: true }]),
    refuse: () => s.aliases.setArtistAliases(owner, MISSING, [{ aliasName: 'No' }]),
  },
  setPartyIdentifiers: {
    actions: ['party.update'],
    run: () =>
      s.aliases.setPartyIdentifiers(owner, ids.person, [
        { identifierType: 'IPI', identifierValue: '00012345678', isPrimary: true },
      ]),
    refuse: () => s.aliases.setPartyIdentifiers(owner, MISSING, []),
  },
  setSocietyAffiliations: {
    actions: ['party.update'],
    run: () => s.aliases.setSocietyAffiliations(owner, ids.person, [{ societyCode: 'BMI' }]),
    refuse: () => s.aliases.setSocietyAffiliations(owner, MISSING, []),
  },
  setContactMethods: {
    actions: ['party.update'],
    run: () =>
      s.methods.setContactMethods(owner, ids.person, [
        { methodType: 'email', value: 'sweep@example.test', isPrimary: true },
      ]),
    refuse: () => s.methods.setContactMethods(owner, MISSING, []),
  },
  createContact: {
    actions: ['party.create', 'contact.create'],
    run: async () => {
      const party = { partyKind: 'person', displayName: 'Sweep Contact' } as const;
      const contact = await value(s.contacts.createContact(owner, { party, roles: ['label'] }));
      ids.contact = contact.contactId;
      return { ok: true, value: contact };
    },
    refuse: () =>
      s.contacts.createContact(owner, {
        party: { partyKind: 'person', displayName: 'No' },
        organizationPartyId: MISSING,
      }),
  },
  updateContact: {
    actions: ['contact.update'],
    run: () => s.contacts.updateContact(owner, ids.contact, { relationshipNotes: 'Swept' }),
    refuse: () => s.contacts.updateContact(owner, 'con_MISSING', { relationshipNotes: 'No' }),
  },
  deleteContact: {
    actions: ['contact.delete'],
    run: () => s.contacts.deleteContact(owner, ids.contact),
    // Theo has pitches, so IntegrityGuard refuses (§4.4).
    refuse: () => s.contacts.deleteContact(owner, keys.con_THEO),
  },
  deleteParty: {
    actions: ['party.delete'],
    run: () => s.parties.deleteParty(owner, ids.person),
    refuse: () => s.parties.deleteParty(owner, MISSING),
  },
  createComposition: {
    actions: ['composition.create'],
    run: async () => {
      const song = await value(s.compositions.createComposition(owner, { title: 'Sweep Song' }));
      ids.composition = song.focus.entityId;
      return { ok: true, value: song };
    },
    refuse: () => s.compositions.createComposition(viewer(), { title: 'No' }),
  },
  updateComposition: {
    actions: ['composition.update'],
    run: () =>
      s.compositions.updateComposition(owner, ids.composition, { title: 'Sweep Song Two' }),
    refuse: () => s.compositions.updateComposition(owner, 'cmp_MISSING', { title: 'No' }),
  },
  createRecording: {
    actions: ['recording.create'],
    run: async () => {
      const input = { compositionId: ids.composition, title: 'Sweep Take' };
      const song = await value(s.recordings.createRecording(owner, input));
      ids.recording = song.recordings.find(({ title }) => title === 'Sweep Take')?.id ?? '';
      return { ok: true, value: song };
    },
    refuse: () =>
      s.recordings.createRecording(owner, { compositionId: 'cmp_MISSING', title: 'No' }),
  },
  updateRecording: {
    actions: ['recording.update'],
    run: () => s.recordings.updateRecording(owner, ids.recording, { bpm: 100 }),
    refuse: () => s.recordings.updateRecording(owner, 'rec_MISSING', { bpm: 100 }),
  },
  updateRecordingArtists: {
    actions: ['recording_artists.replace'],
    run: () =>
      s.artists.updateRecordingArtists(owner, ids.recording, [
        { partyId: keys.pty_JORDAN, role: 'primary' },
      ]),
    refuse: () =>
      s.artists.updateRecordingArtists(owner, ids.recording, [
        { partyId: MISSING, role: 'primary' },
      ]),
  },
  replaceCompositionRegistrations: {
    actions: ['composition_registrations.replace'],
    run: () =>
      s.registrations.replaceCompositionRegistrations(owner, ids.composition, [
        { registryKind: 'pro', societyCode: 'BMI', workCode: '12345678' },
      ]),
    refuse: () =>
      s.registrations.replaceCompositionRegistrations(owner, 'cmp_MISSING', [
        { registryKind: 'mlc' },
      ]),
  },
  replaceRecordingRegistrations: {
    actions: ['recording_registrations.replace'],
    run: () =>
      s.registrations.replaceRecordingRegistrations(owner, ids.recording, [
        { registryKind: 'soundexchange', status: 'pending' },
      ]),
    refuse: () =>
      s.registrations.replaceRecordingRegistrations(owner, 'rec_MISSING', [
        { registryKind: 'soundexchange' },
      ]),
  },
  ensureTerms: {
    actions: ['metadata_term.create'],
    run: () => s.terms.ensureTerms(owner, [{ termType: 'genre', label: 'Sweep Genre' }]),
    refuse: () => s.terms.ensureTerms(viewer(), [{ termType: 'genre', label: 'No' }]),
  },
  createRelease: {
    actions: ['release.create'],
    run: async () => {
      const tracks = [{ recordingId: ids.recording, discNumber: 1, trackNumber: 1 }];
      const release = await value(
        s.releases.createRelease(owner, { title: 'Sweep Single', tracks }),
      );
      ids.release = release.id;
      return { ok: true, value: release };
    },
    refuse: () =>
      s.releases.createRelease(owner, {
        title: 'No',
        tracks: [{ recordingId: 'rec_MISSING', discNumber: 1, trackNumber: 1 }],
      }),
  },
  updateRelease: {
    actions: ['release.update'],
    run: () => s.releases.updateRelease(owner, ids.release, { title: 'Sweep Single Two' }),
    refuse: () => s.releases.updateRelease(owner, 'rel_MISSING', { title: 'No' }),
  },
  deleteRelease: {
    actions: ['release.delete'],
    run: () => s.deletes.deleteRelease(owner, ids.release),
    refuse: () => s.deletes.deleteRelease(owner, 'rel_MISSING'),
  },
  createSong: {
    actions: ['composition.create', 'recording.create'],
    run: async () => {
      const song = await value(s.songs.createSong(owner, { title: 'Sweep Pair' }));
      ids.pair = song.focus.entityId;
      ids.pairTake = song.recordings[0].id;
      return { ok: true, value: song };
    },
    refuse: () => s.songs.createSong(owner, { title: 'No', isrc: 'not an isrc' }),
  },
  deleteRecording: {
    actions: ['recording.delete'],
    run: () => s.deletes.deleteRecording(owner, ids.pairTake),
    // Midnight Drive's master has interests and pitches (§4.4).
    refuse: () => s.deletes.deleteRecording(owner, keys.rec_MIDNIGHT),
  },
  deleteComposition: {
    actions: ['composition.delete'],
    run: () => s.deletes.deleteComposition(owner, ids.pair),
    refuse: () => s.deletes.deleteComposition(owner, keys.cmp_MIDNIGHT),
  },
  deleteSong: {
    actions: ['composition.delete', 'recording.delete'],
    setup: async () => {
      ids.doomed = (
        await value(s.songs.createSong(owner, { title: 'Sweep Doomed' }))
      ).focus.entityId;
    },
    run: () => s.songs.deleteSong(owner, ids.doomed),
    refuse: () => s.songs.deleteSong(owner, keys.cmp_MIDNIGHT),
  },
  updateWriterShares: {
    actions: ['writer_shares.replace'],
    run: () =>
      s.shares.updateWriterShares(owner, {
        compositionId: ids.composition,
        shares: [{ partyId: keys.pty_JORDAN, roles: ['songwriter'], shareBp: 10_000 }],
      }),
    refuse: () =>
      s.shares.updateWriterShares(owner, {
        compositionId: ids.composition,
        shares: [{ partyId: MISSING, roles: ['songwriter'], shareBp: 10_000 }],
      }),
  },
  updatePublishingShares: {
    actions: ['publishing_shares.replace'],
    run: () =>
      s.holderShares.updatePublishingShares(owner, {
        ...{ compositionId: ids.composition, territory: 'WORLD' },
        shares: [{ partyId: keys.pty_NIGHTSHIFT, shareBp: 10_000 }],
      }),
    refuse: () =>
      s.holderShares.updatePublishingShares(owner, {
        ...{ compositionId: ids.composition, territory: 'WORLD' },
        shares: [{ partyId: MISSING, shareBp: 10_000 }],
      }),
  },
  updateMasterShares: {
    actions: ['master_shares.replace'],
    run: () =>
      s.holderShares.updateMasterShares(owner, {
        recordingId: ids.recording,
        shares: [{ partyId: keys.pty_NIGHTSHIFT, shareBp: 10_000 }],
      }),
    refuse: () =>
      s.holderShares.updateMasterShares(owner, {
        recordingId: ids.recording,
        shares: [{ partyId: MISSING, shareBp: 10_000 }],
      }),
  },
  createAgreement: {
    actions: ['agreement.create'],
    run: async () => {
      const input = { agreementType: 'representation', title: 'Sweep Deal' } as const;
      const agreement = await value(s.agreements.createAgreement(owner, input));
      ids.agreement = agreement.id;
      return { ok: true, value: agreement };
    },
    refuse: () =>
      s.agreements.createAgreement(owner, {
        ...{ agreementType: 'representation', title: 'No' },
        counterpartyPartyId: MISSING,
      }),
  },
  updateAgreement: {
    actions: ['agreement.update'],
    run: () => s.agreements.updateAgreement(owner, ids.agreement, { notes: 'Swept' }),
    refuse: () => s.agreements.updateAgreement(owner, 'agr_MISSING', { notes: 'No' }),
  },
  attestRepresentation: {
    actions: ['representation.attest'],
    setup: async () => {
      const where = eq(tables.masterInterests.recordingId, ids.recording);
      const [interest] = await (await open()).select().from(tables.masterInterests).where(where);
      ids.interest = interest.id;
    },
    run: () =>
      s.representation.attestRepresentation(owner, {
        ...{ interestType: 'master', interestId: ids.interest },
        ...{ agreementId: ids.agreement, attested: true },
      }),
    refuse: () =>
      s.representation.attestRepresentation(owner, {
        ...{ interestType: 'master', interestId: 'mas_MISSING', attested: true },
      }),
  },
  updateLicensingContacts: {
    actions: ['licensing_contacts.replace'],
    run: () =>
      s.representation.updateLicensingContacts(owner, {
        recordingId: ids.recording,
        contacts: [{ partyId: keys.pty_NIGHTSHIFT }],
      }),
    refuse: () =>
      s.representation.updateLicensingContacts(owner, {
        recordingId: ids.recording,
        contacts: [{ partyId: MISSING }],
      }),
  },
  updateSelfParties: {
    actions: ['self_parties.update'],
    run: () =>
      s.selfParties.updateSelfParties(owner, {
        ...{ writer: keys.pty_JORDAN, publishing: keys.pty_SILVERLINE },
        master: keys.pty_NIGHTSHIFT,
      }),
    refuse: () =>
      s.selfParties.updateSelfParties(owner, { writer: MISSING, publishing: null, master: null }),
  },
  createUpload: {
    // Signing writes no row (AST-001); completeUpload registers the asset.
    actions: [],
    run: () =>
      s.assets.createUpload(owner, {
        assetType: 'audio',
        fileName: 'a.mp3',
        contentType: 'audio/mpeg',
      }),
    refuse: () =>
      s.assets.createUpload(owner, {
        assetType: 'audio',
        fileName: 'a.html',
        contentType: 'text/html',
      }),
  },
  completeUpload: {
    actions: ['asset.create'],
    setup: uploaded,
    run: () =>
      s.assets.completeUpload(owner, {
        assetId: ids.asset,
        assetType: 'audio',
        fileName: 'sweep.mp3',
      }),
    refuse: () =>
      s.assets.completeUpload(owner, {
        ...{ assetId: 'ast_01K0000000000000000000000Z', assetType: 'audio', fileName: 'sweep.mp3' },
      }),
  },
  addAsset: {
    actions: ['asset.attach'],
    run: () =>
      s.assets.addAsset(owner, {
        ...{
          assetId: ids.asset,
          target: { recordingId: ids.recording },
          relationship: 'audio_master',
        },
      }),
    refuse: () =>
      s.assets.addAsset(owner, {
        ...{
          assetId: ids.asset,
          target: { recordingId: 'rec_MISSING' },
          relationship: 'audio_master',
        },
      }),
  },
});

beforeAll(async () => {
  services = await prepareWorkspaceServices('phase4-writes');
  const loaded = await Promise.all(Object.values(MODULES).map((load) => load()));
  s = Object.fromEntries(Object.keys(MODULES).map((name, i) => [name, loaded[i]])) as Modules;
  owner = await seedNorthstarTenant();
  const selection = await import('../../src/server/services/assets/get-asset-storage');
  storage = selection.getLocalAssetStorage() as LocalAssetStorage;
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-rpr.42: every phase 4 write keeps DAT-001 and AUD-001', () => {
  it('has a sweep case for every exported write', () => {
    const exported = Object.values(s).flatMap((module) =>
      Object.entries(module)
        .filter(([name, member]) => typeof member === 'function' && WRITE.test(name))
        .map(([name]) => name),
    );
    expect(exported.sort()).toEqual(Object.keys(cases()).sort());
  });

  it('writes every Phase 4 action in the §6.6 vocabulary', () => {
    // report, import, approval and message actions belong to later phases.
    const contract = readFileSync('docs/CONTRACT.md', 'utf8');
    const vocabulary = contract.match(/Action vocabulary[^\n]*/)?.[0] ?? '';
    const phase4 = [...vocabulary.matchAll(/`([a-z_]+\.[a-z_]+)`/g)]
      .map(([, action]) => action)
      .filter((action) => !/^(report|import|approval|message)\./.test(action));
    const written = new Set(Object.values(cases()).flatMap(({ actions }) => actions));
    // representation.clear is the same service call with attested false.
    written.add('representation.clear');
    expect(phase4.filter((action) => !written.has(action))).toEqual([]);
    expect(phase4.length).toBeGreaterThan(20);
  });

  it('writes exactly its audit actions on success, and nothing on a refusal', async () => {
    const consistent = async (name: string) =>
      expect(await (await open()).all(sql`PRAGMA foreign_key_check`), name).toEqual([]);
    for (const [name, write] of Object.entries(cases())) {
      await write.setup?.();
      const before = new Set(await auditActions());
      const refused = await write.refuse();
      expect(refused.ok, `${name} refusal`).toBe(false);
      expect(await auditActions(), `${name} refusal audits`).toHaveLength(before.size);
      await consistent(`${name} refusal`);

      const result = await write.run();
      if (!result.ok) throw new Error(`${name} refused with ${JSON.stringify(result.error)}`);
      const added = (await auditActions()).filter((row) => !before.has(row));
      const actions = added.map((row) => row.split(' ')[1]);
      expect(actions.sort(), name).toEqual([...write.actions].sort());
      await consistent(name);
    }
  });
});
