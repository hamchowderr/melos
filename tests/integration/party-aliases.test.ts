import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Aliases = typeof import('../../src/server/services/contacts/aliases');

let services: Services;
let service: Aliases;
let owner: TenantContext;
const { auditLog, partyIdentifiers, recordingArtists } = tables;
const { pty_JORDAN: JORDAN, pty_ALEX: ALEX, rec_MIDNIGHT: MIDNIGHT } = NORTHSTAR.keys;
const IPI = '00012345678';

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });

beforeAll(async () => {
  services = await prepareWorkspaceServices('party-aliases');
  service = await import('../../src/server/services/contacts/aliases');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async (entityId: string) =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, entityId));
const noForeignKeyErrors = async () =>
  expect(await (await open(owner)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);

async function accepted<T>(
  pending: Promise<{ ok: true; value: T } | { ok: false; error: object }>,
) {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('melos-rpr.26: aliases, identifiers and society affiliations (CAT-008)', () => {
  it('attaches an IPI to the alias JT, audits each set once, and nulls references on alias delete', async () => {
    const audits = (await auditsOf(JORDAN)).length;
    const withAlias = await accepted(
      service.setArtistAliases(owner, JORDAN, [{ aliasName: ' JT ', isPrimary: true }]),
    );
    const jt = withAlias.aliases.find((alias) => alias.aliasName === 'JT');
    expect(jt).toMatchObject({ aliasType: 'stage_name', isPrimary: true });
    const withIpi = await accepted(
      service.setPartyIdentifiers(owner, JORDAN, [
        { identifierType: 'IPI', identifierValue: IPI, artistAliasId: jt?.id, isPrimary: true },
      ]),
    );
    expect(withIpi.identifiers).toMatchObject([{ identifierValue: IPI, aliasName: 'JT' }]);
    const database = await open(owner);
    await database
      .update(recordingArtists)
      .set({ artistAliasId: jt?.id })
      .where(eq(recordingArtists.recordingId, MIDNIGHT));
    await accepted(service.setArtistAliases(owner, JORDAN, []));
    const [ipi] = await database
      .select()
      .from(partyIdentifiers)
      .where(eq(partyIdentifiers.partyId, JORDAN));
    expect(ipi.artistAliasId).toBeNull();
    const credits = await database
      .select()
      .from(recordingArtists)
      .where(eq(recordingArtists.recordingId, MIDNIGHT));
    expect(credits.every((credit) => credit.artistAliasId === null)).toBe(true);
    const rows = await auditsOf(JORDAN);
    expect(rows.slice(audits).map((row) => row.action)).toEqual([
      'party.update',
      'party.update',
      'party.update',
    ]);
    expect(JSON.parse(rows.at(-1)?.beforeJson ?? '{}').aliases).toHaveLength(1);
    await noForeignKeyErrors();
    // The same identifier set again writes nothing.
    await accepted(
      service.setPartyIdentifiers(owner, JORDAN, [
        { id: ipi.id, identifierType: 'IPI', identifierValue: IPI, isPrimary: true },
      ]),
    );
    expect(await auditsOf(JORDAN)).toHaveLength(rows.length);
  });

  it('refuses a duplicate IPI, a foreign alias and bad sets, writing nothing', async () => {
    const theirs = await accepted(service.setArtistAliases(owner, JORDAN, [{ aliasName: 'J.T.' }]));
    const audits = (await auditsOf(ALEX)).length;
    const ipi = { identifierType: 'IPI', identifierValue: IPI } as const;
    expect(await service.setPartyIdentifiers(owner, ALEX, [ipi])).toEqual(
      refused({ code: 'CONFLICT', field: 'identifiers' }),
    );
    expect(
      await service.setPartyIdentifiers(owner, ALEX, [
        { ...ipi, identifierValue: '99', artistAliasId: theirs.aliases[0].id },
      ]),
    ).toEqual(invalid('identifiers', 'alias_of_other_party'));
    const cases: [Promise<unknown>, object][] = [
      [
        service.setPartyIdentifiers(owner, ALEX, [ipi, ipi]),
        invalid('identifiers', 'duplicate_identifier'),
      ],
      [
        service.setArtistAliases(owner, ALEX, [{ aliasName: 'A' }, { aliasName: 'A' }]),
        invalid('aliases', 'duplicate_alias'),
      ],
      [
        service.setSocietyAffiliations(owner, ALEX, [
          { societyCode: 'BMI', startsOn: '2026-02-01', endsOn: '2026-01-01' },
        ]),
        invalid('societyAffiliations', 'ends_before_start'),
      ],
      [
        service.setArtistAliases(owner, ALEX, [{ id: 'nope', aliasName: 'A' }]),
        refused({ code: 'NOT_FOUND' }),
      ],
    ];
    for (const [pending, refusal] of cases) expect(await pending).toEqual(refusal);
    expect(await auditsOf(ALEX)).toHaveLength(audits);
    await noForeignKeyErrors();
  });

  it('sets society affiliations and refuses a viewer before the database opens', async () => {
    const set = await accepted(
      service.setSocietyAffiliations(owner, ALEX, [
        { societyCode: 'bmi', role: 'writer', startsOn: '2020-01-01' },
      ]),
    );
    expect(set.societyAffiliations).toMatchObject([{ societyCode: 'BMI', role: 'writer' }]);
    services.getWorkspaceDatabase.mockClear();
    expect(await service.setSocietyAffiliations(withRole(owner, 'viewer'), ALEX, [])).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const other = await services.provision('owner');
    expect(await service.setArtistAliases(other, ALEX, [])).toEqual(refused({ code: 'NOT_FOUND' }));
  });
});
