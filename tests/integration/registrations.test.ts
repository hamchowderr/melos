import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Registrations = typeof import('../../src/server/services/catalog/registrations');

let services: Services;
let service: Registrations;
let owner: TenantContext;
const { auditLog, compositionRegistrations } = tables;
const { cmp_MIDNIGHT: MIDNIGHT, rec_MIDNIGHT: TAKE } = NORTHSTAR.keys;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (reason: string) => ({
  ok: false,
  error: { code: 'VALIDATION', field: 'registrations', reason },
});

beforeAll(async () => {
  services = await prepareWorkspaceServices('registrations');
  service = await import('../../src/server/services/catalog/registrations');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async (entityId: string) =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, entityId));
const rowsOf = async () =>
  (await open(owner))
    .select()
    .from(compositionRegistrations)
    .where(eq(compositionRegistrations.compositionId, MIDNIGHT));

describe('melos-9b6.2: song registrations (CAT-010, CAT-INT-010)', () => {
  it('stores a PRO and The MLC with their codes, normalized, and audits the set once', async () => {
    const member = withRole(owner, 'member');
    const result = await service.replaceCompositionRegistrations(member, MIDNIGHT, [
      { registryKind: 'pro', societyCode: ' bmi ', workCode: ' 12345678 ' },
      { registryKind: 'mlc', workCode: 'M1234X', registeredOn: '2026-10-01' },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.composition?.registrations).toMatchObject([
      { registryKind: 'mlc', societyCode: null, workCode: 'M1234X', status: 'registered' },
      { registryKind: 'pro', societyCode: 'BMI', workCode: '12345678', registeredOn: null },
    ]);
    const audits = await auditsOf(MIDNIGHT);
    expect(audits.map(({ action }) => action)).toEqual(['composition_registrations.replace']);
    expect(await (await open(owner)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps a row id across a replace, removes rows left out, and writes nothing for the same set', async () => {
    const [bmi] = (await rowsOf()).filter((row) => row.registryKind === 'pro');
    const set = [{ registryKind: 'pro' as const, societyCode: 'BMI', status: 'pending' as const }];
    const result = await service.replaceCompositionRegistrations(owner, MIDNIGHT, set);
    expect(result.ok).toBe(true);
    const after = await rowsOf();
    expect(after.map(({ id, status, workCode }) => ({ id, status, workCode }))).toEqual([
      { id: bmi.id, status: 'pending', workCode: null },
    ]);
    const audits = (await auditsOf(MIDNIGHT)).length;
    await service.replaceCompositionRegistrations(owner, MIDNIGHT, set);
    expect(await auditsOf(MIDNIGHT)).toHaveLength(audits);
  });

  it('records SoundExchange on the recording', async () => {
    const result = await service.replaceRecordingRegistrations(owner, TAKE, [
      { registryKind: 'soundexchange', registrationCode: 'SX-1' },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const take = result.value.recordings.find(({ id }) => id === TAKE);
    expect(take?.registrations).toMatchObject([
      { registryKind: 'soundexchange', registrationCode: 'SX-1', status: 'registered' },
    ]);
  });

  it('refuses broken sets before the database opens, and a viewer or missing song', async () => {
    const cases = [
      [[{ registryKind: 'pro' }], 'society_required'],
      [[{ registryKind: 'mlc', societyCode: 'BMI' }], 'society_only_for_pro'],
      [
        [
          { registryKind: 'pro', societyCode: 'BMI' },
          { registryKind: 'pro', societyCode: 'bmi' },
        ],
        'duplicate_registration',
      ],
      [[{ registryKind: 'mlc', registeredOn: '2026-13-01' }], 'not_a_date'],
      [[{ registryKind: 'soundexchange' }], 'unknown_registry'],
      [[{ registryKind: 'mlc', status: 'filed' }], 'unknown_status'],
    ] as const;
    for (const [set, reason] of cases)
      expect(await service.replaceCompositionRegistrations(owner, MIDNIGHT, set as never)).toEqual(
        refused(reason),
      );
    const viewer = await service.replaceCompositionRegistrations(
      withRole(owner, 'viewer'),
      MIDNIGHT,
      [],
    );
    expect(viewer).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
    const missing = await service.replaceRecordingRegistrations(owner, 'rec_MISSING', []);
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
