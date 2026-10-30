import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Rights = typeof import('../../src/server/services/rights/read');

let services: Services;
let rights: Rights;
let owner: TenantContext;
const { keys } = NORTHSTAR;
const AT = '2026-10-30T00:00:00.000Z';
const focus = { entityType: 'recording', entityId: keys.rec_MIDNIGHT } as const;

beforeAll(async () => {
  services = await prepareWorkspaceServices('readiness-registrations');
  rights = await import('../../src/server/services/rights/read');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

async function readiness() {
  const result = await rights.getRightsSummary(owner, focus);
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value.issues.map(({ code }) => code);
}

describe('RGT-INT-010: registration, sample, instrumental and exclusivity readiness', () => {
  it('warns until each registration, the instrumental and cleared samples are on file', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const stamps = { createdAt: AT, updatedAt: AT };
    const warnings = ['NOT_REGISTERED_PRO', 'NOT_REGISTERED_MLC', 'NOT_REGISTERED_SOUNDEXCHANGE'];
    expect(await readiness()).toEqual([...warnings, 'NO_INSTRUMENTAL']);

    // A pending registration does not count; registered ones clear their warnings.
    const song = { compositionId: keys.cmp_MIDNIGHT, ...stamps };
    await database.insert(tables.compositionRegistrations).values([
      { id: 'creg_PRO', ...song, registryKind: 'pro', societyCode: 'BMI' },
      { id: 'creg_MLC', ...song, registryKind: 'mlc', status: 'pending' },
    ]);
    const take = { recordingId: keys.rec_MIDNIGHT, ...stamps };
    await database
      .insert(tables.recordingRegistrations)
      .values({ id: 'rreg_SX', ...take, registryKind: 'soundexchange' });
    const asset = { assetType: 'audio', storageProvider: 'local', fileName: 'inst.wav' };
    await database
      .insert(tables.assets)
      .values({ id: 'ast_INST', ...asset, storageKey: 'w/inst.wav', createdAt: AT });
    await database.insert(tables.recordingAssets).values({
      recordingId: keys.rec_MIDNIGHT,
      assetId: 'ast_INST',
      relationship: 'instrumental',
    });
    expect(await readiness()).toEqual(['NOT_REGISTERED_MLC']);

    // Uncleared samples block sync readiness only; clearing them lifts it.
    await database
      .update(tables.recordings)
      .set({ containsSamples: 1 })
      .where(eq(tables.recordings.id, keys.rec_MIDNIGHT));
    const query = { recordingId: keys.rec_MIDNIGHT, onlyNotReady: false };
    const summary = await rights.getReadinessIssues(owner, query);
    if (!summary.ok) throw new Error(summary.error.code);
    expect(summary.value.recordings[0]).toMatchObject({ oneStopReady: true, syncReady: false });
    expect(await readiness()).toEqual(['SAMPLES_NOT_CLEARED', 'NOT_REGISTERED_MLC']);
  });

  it('warns about a live exclusive agreement with another party behind a share', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const deal = {
      agreementType: 'master',
      title: 'Exclusive sync rep',
      createdAt: AT,
      updatedAt: AT,
    };
    await database.insert(tables.agreements).values({
      ...{ id: 'agr_EXCL', ...deal, isExclusive: 1, counterpartyPartyId: keys.pty_CARTER_SYNC },
    });
    const master = eq(tables.masterInterests.id, keys['master_interests:MIDNIGHT_SILVERLINE']);
    await database.update(tables.masterInterests).set({ agreementId: 'agr_EXCL' }).where(master);
    expect(await readiness()).toContain('EXCLUSIVE_AGREEMENT');
    const agreement = eq(tables.agreements.id, 'agr_EXCL');
    // Expired, or with a self party as counterparty, it no longer warns.
    await database.update(tables.agreements).set({ expiresOn: '2020-01-01' }).where(agreement);
    expect(await readiness()).not.toContain('EXCLUSIVE_AGREEMENT');
    const self = { expiresOn: null, counterpartyPartyId: keys.pty_SILVERLINE };
    await database.update(tables.agreements).set(self).where(agreement);
    expect(await readiness()).not.toContain('EXCLUSIVE_AGREEMENT');
  });
});
