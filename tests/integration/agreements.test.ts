import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgreementType, AgreementPatch as Patch } from '../../src/lib/dto/rights';
import * as tables from '../../src/server/db/schema/workspace.generated';
import { canonicalJson } from '../../src/server/services/audit-writer';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Agreements = typeof import('../../src/server/services/rights/agreements');

const AT = '2026-09-15T12:00:00.000Z';
/** In the first workspace: Silverline Songs, a soft-deleted party and an agreement PDF asset. */
const [SILVERLINE, GONE, ASSET] = [`pty_${ulid()}`, `pty_${ulid()}`, `ast_${ulid()}`];
const refused = (error: object) => ({ ok: false, error });
const [FORBIDDEN, NOT_FOUND] = [refused({ code: 'FORBIDDEN' }), refused({ code: 'NOT_FOUND' })];
const missing = (table: string) => refused({ code: 'NOT_FOUND', counts: { [table]: 1 } });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });
const DEAL = { agreementType: 'publishing', title: 'Admin deal' } as const;
const party = (id: string, displayName: string, deletedAt: string | null = null) => ({
  ...{ id, partyKind: 'organization', displayName, deletedAt, createdAt: AT, updatedAt: AT },
});
let services: Services;
let service: Agreements;
let owner: TenantContext;
let other: TenantContext;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}
const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const stored = async (tenant: TenantContext, id: string) =>
  (await open(tenant)).select().from(tables.agreements).where(eq(tables.agreements.id, id));
/** The tenant's audit rows, after asserting PRAGMA foreign_key_check is empty (DAT-INT-001). */
async function audited(tenant: TenantContext) {
  const database = await open(tenant);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  return database.select().from(tables.auditLog);
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('agreements');
  service = await import('../../src/server/services/rights/agreements');
  [owner, other] = [await services.provision('owner'), await services.provision('owner')];
  const database = await open(owner);
  const [live, gone] = [party(SILVERLINE, 'Silverline Songs'), party(GONE, 'Gone Music', AT)];
  await database.insert(tables.parties).values([live, gone]);
  const pdf = { id: ASSET, assetType: 'agreement_pdf', storageProvider: 'local', createdAt: AT };
  const key = `${owner.workspaceId}/${ASSET}/deal.pdf`;
  await database.insert(tables.assets).values({ ...pdf, storageKey: key, fileName: 'deal.pdf' });
});

afterAll(() => services?.close());

describe('melos-rpr.15: agreements that back publishing, master and licensing rows (RGT-006)', () => {
  it('lets owner, admin and member write; viewer and owner,viewer get FORBIDDEN before the database opens (§6.2, D-5)', async () => {
    let id = '';
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['owner', 'admin', 'member']) {
      const tenant = withRole(owner, role);
      id = accepted(await service.createAgreement(tenant, DEAL)).id;
      const updated = await service.updateAgreement(tenant, id, { notes: role });
      expect(updated, role).toMatchObject({ ok: true, value: { id, notes: role } });
    }
    expect(services.getWorkspaceDatabase).toHaveBeenCalledTimes(6);
    await audited(owner);
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'owner,viewer']) {
      const tenant = withRole(owner, role);
      expect(await service.createAgreement(tenant, DEAL), role).toEqual(FORBIDDEN);
      // The permission comes before validation.
      expect(await service.createAgreement(tenant, { ...DEAL, title: '' })).toEqual(FORBIDDEN);
      expect(await service.updateAgreement(tenant, id, { notes: role })).toEqual(FORBIDDEN);
    }
    expect(await service.listAgreements(withRole(owner, 'owner,viewer'))).toEqual(FORBIDDEN);
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect((await stored(owner, id))[0].notes).toBe('member');
  });

  it('audits a create and an update once each with the full row, stores the asset, and leaves an unchanged patch unwritten (AUD-INT-001, D-4)', async () => {
    const earlier = (await audited(owner)).length;
    const input = {
      agreementType: 'representation' as AgreementType,
      title: '  Silverline representation ',
      ...{ counterpartyPartyId: SILVERLINE, effectiveOn: '2026-01-01', expiresOn: '2028-12-31' },
      ...{ assetId: ASSET, notes: 'Side deal in Personal Notes' },
    };
    const created = accepted(await service.createAgreement(owner, input));
    const [row] = await stored(owner, created.id);
    const by = { createdBy: owner.userId, updatedBy: owner.userId, createdAt: row.updatedAt };
    const fixed = { id: created.id, title: 'Silverline representation', updatedAt: row.updatedAt };
    const unflagged = { isExclusive: 0, exclusivityScope: null };
    expect(row).toEqual({ ...input, ...unflagged, ...by, ...fixed });
    expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const dto = { isExclusive: false, counterpartyName: 'Silverline Songs' };
    expect(created).toEqual({ ...row, ...dto });
    const patch = { expiresOn: null, notes: null };
    const updated = accepted(await service.updateAgreement(owner, created.id, patch));
    const [after] = await stored(owner, created.id);
    expect(after).toEqual({ ...row, ...patch, updatedAt: after.updatedAt });
    expect(updated).toEqual({ ...after, ...dto });
    const actor = { actorType: 'user', actorUserId: owner.userId, requestId: owner.requestId };
    const entry = { ...actor, entityType: 'agreement', entityId: created.id };
    const [before, now, audits] = [canonicalJson(row), canonicalJson(after), await audited(owner)];
    expect(audits.slice(earlier)).toMatchObject([
      { ...entry, action: 'agreement.create', beforeJson: null, afterJson: before },
      { ...entry, action: 'agreement.update', beforeJson: before, afterJson: now },
    ]);
    // An empty or same-value patch from a second user keeps updatedBy, updatedAt and the audit rows.
    const second = { ...owner, userId: `usr_${ulid()}` };
    for (const same of [{}, { title: after.title, assetId: ASSET, expiresOn: null }]) {
      const result = await service.updateAgreement(second, created.id, same);
      expect(result).toEqual({ ok: true, value: updated });
    }
    expect([await stored(owner, created.id), await audited(owner)]).toEqual([[after], audits]);
  });

  it('refuses a missing or deleted counterparty or asset with NOT_FOUND and broken fields with VALIDATION, writing nothing', async () => {
    const later = { ...DEAL, effectiveOn: '2026-05-01' };
    const kept = accepted(await service.createAgreement(owner, later));
    const [rows, earlier] = [await stored(owner, kept.id), await audited(owner)];
    const refusesBoth = async (cases: [Patch, object][]) => {
      for (const [fields, refusal] of cases) {
        expect(await service.createAgreement(owner, { ...later, ...fields })).toEqual(refusal);
        expect(await service.updateAgreement(owner, kept.id, fields)).toEqual(refusal);
      }
    };
    const early = invalid('expiresOn', 'expires_before_effective');
    // An update's expiresOn is checked against the stored effectiveOn, 2026-05-01.
    await refusesBoth([
      [{ counterpartyPartyId: `pty_${ulid()}` }, missing('parties')],
      [{ counterpartyPartyId: GONE }, missing('parties')],
      [{ assetId: `ast_${ulid()}` }, missing('assets')],
      [{ expiresOn: '2026-04-30' }, early],
    ]);
    const unknown = await service.updateAgreement(owner, `agr_${ulid()}`, { notes: 'x' });
    expect(unknown).toEqual(NOT_FOUND);
    services.getWorkspaceDatabase.mockClear();
    await refusesBoth([
      [{ effectiveOn: '2026-05-01', expiresOn: '2026-04-30' }, early],
      [{ agreementType: 'sync' as AgreementType }, invalid('agreementType', 'not_allowed')],
      [{ title: '   ' }, invalid('title', 'required')],
      [{ effectiveOn: '2026-02-30' }, invalid('effectiveOn', 'not_a_date')],
    ]);
    // These checks need no stored row, so they never open the database.
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect([await stored(owner, kept.id), await audited(owner)]).toEqual([rows, earlier]);
  });

  it('never resolves an id from another workspace: its agreement and its counterparty are NOT_FOUND (TEN-001)', async () => {
    const mine = { ...DEAL, counterpartyPartyId: SILVERLINE };
    const { id } = accepted(await service.createAgreement(owner, mine));
    expect(await service.updateAgreement(other, id, { notes: 'x' })).toEqual(NOT_FOUND);
    expect(await service.createAgreement(other, mine)).toEqual(missing('parties'));
    expect(await service.listAgreements(other)).toEqual({ ok: true, value: [] });
    expect(await audited(other)).toEqual([]);
  });

  it('lists every agreement by title ignoring case, with its counterparty, for any role with rights:read', async () => {
    const rivera = `pty_${ulid()}`;
    await (await open(other)).insert(tables.parties).values(party(rivera, 'Rivera Music'));
    const add = async (fields: Patch) =>
      accepted(await service.createAgreement(other, { ...DEAL, ...fields }));
    const withRivera = await add({ title: 'B deal', counterpartyPartyId: rivera });
    const alone = await add({ agreementType: 'licensing', title: 'a deal' });
    expect([withRivera.counterpartyName, alone.counterpartyName]).toEqual(['Rivera Music', null]);
    const list = async (filter?: Parameters<Agreements['listAgreements']>[1]) =>
      accepted(await service.listAgreements(withRole(other, 'viewer'), filter));
    expect(await list()).toEqual([alone, withRivera]);
    expect(await list({ agreementType: 'licensing' })).toEqual([alone]);
    expect(await list({ counterpartyPartyId: rivera })).toEqual([withRivera]);
  });

  it('RGT-INT-009: records an exclusive agreement and its scope, defaulting to not exclusive', async () => {
    const plain = accepted(await service.createAgreement(owner, DEAL));
    expect(plain).toMatchObject({ isExclusive: false, exclusivityScope: null });
    const scope = { isExclusive: true, exclusivityScope: '  sync, worldwide ' };
    const exclusive = accepted(await service.updateAgreement(owner, plain.id, scope));
    expect(exclusive).toMatchObject({ isExclusive: true, exclusivityScope: 'sync, worldwide' });
    expect((await stored(owner, plain.id))[0]).toMatchObject({ isExclusive: 1 });
    const cleared = { isExclusive: false, exclusivityScope: ' ' };
    const after = accepted(await service.updateAgreement(owner, plain.id, cleared));
    expect(after).toMatchObject({ isExclusive: false, exclusivityScope: null });
  });
});
