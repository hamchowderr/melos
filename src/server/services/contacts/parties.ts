import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { PartyDetailDTO, PartyInput, PartyPatch } from '../../../lib/dto/contacts';
import { FOREIGN_KEY_RULES } from '../../db/fk-rules.generated';
import { organizations, parties, people } from '../../db/schema/workspace.generated';
import { reindexRecording, reindexSong } from '../catalog/search-index';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getParty } from './read';

const CREATE: WorkspacePermissions = { contact: ['create'] };
const UPDATE: WorkspacePermissions = { contact: ['update'] };
const DELETE: WorkspacePermissions = { contact: ['delete'] };
const KINDS = ['person', 'organization'] as const;

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/**
 * The rules that check a party's kind (§4.4 rule 1) besides its own people or organizations row,
 * which a kind change replaces: a kind change is refused while any of them holds a row.
 */
const KIND_CHECKED = FOREIGN_KEY_RULES.workspace.filter(
  (rule) =>
    rule.parentTable === 'parties' &&
    rule.parentColumns.includes('party_kind') &&
    rule.table !== 'people' &&
    rule.table !== 'organizations',
);

/** VALIDATION for the first broken field, before the database opens. */
function invalid(fields: PartyPatch, create: boolean): ServiceResult<never> | null {
  if ((create || fields.partyKind !== undefined) && !KINDS.includes(fields.partyKind as never))
    return refuse('partyKind', 'unknown_kind');
  if ((create || fields.displayName !== undefined) && !fields.displayName?.trim())
    return refuse('displayName', 'required');
  const legal = fields.person?.legalName ?? fields.organization?.legalName;
  if (legal !== undefined && !legal.trim()) return refuse('legalName', 'required');
  return null;
}

/** A live party with its subtype row, read in the write transaction for the audit log. */
async function load(tx: WorkspaceTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, id), isNull(parties.deletedAt)));
  if (!row) return undefined;
  const [person] = await tx.select().from(people).where(eq(people.partyId, id));
  const [organization] = await tx.select().from(organizations).where(eq(organizations.partyId, id));
  return { ...row, person: person ?? null, organization: organization ?? null };
}

type Stored = NonNullable<Awaited<ReturnType<typeof load>>>;

/** The people or organizations row for `kind`, from the patch over what the party holds now. */
function subtypeOf(id: string, kind: string, name: string, fields: PartyPatch, now?: Stored) {
  if (kind === 'person') {
    const held = now?.person;
    const given = { ...held, ...fields.person };
    const legalName = given.legalName?.trim() || held?.legalName || name;
    return { table: people, row: { partyId: id, ...given, legalName, partyKind: 'person' } };
  }
  const held = now?.organization;
  const given = { ...held, ...fields.organization };
  const legalName = given.legalName?.trim() || held?.legalName || name;
  return {
    table: organizations,
    row: { partyId: id, ...given, legalName, partyKind: 'organization' },
  };
}

/** The live rows that check `id`'s kind, by table: what a kind change must wait for. */
async function kindReferences(tx: WorkspaceTransaction, id: string) {
  const counts: Record<string, number> = {};
  for (const rule of KIND_CHECKED) {
    const column = sql.identifier(rule.columns[rule.parentColumns.indexOf('id')]);
    const query = sql`SELECT count(*) AS n FROM ${sql.identifier(rule.table)} WHERE ${column} = ${id}`;
    const [{ n }] = await tx.all<{ n: number }>(query);
    if (n) counts[rule.table] = (counts[rule.table] ?? 0) + n;
  }
  return counts;
}

/**
 * Re-derives catalog_search for every song that credits `id` (G-13): compositions it writes for,
 * and recordings it performs or contributes to, through their composition or on their own.
 */
async function reindexCredits(tx: WorkspaceTransaction, id: string) {
  const credited = sql`SELECT recording_id FROM recording_artists WHERE party_id = ${id}
    UNION SELECT recording_id FROM recording_contributors WHERE party_id = ${id}`;
  const songs = await tx.all<{ id: string }>(sql`
    SELECT composition_id AS id FROM composition_contributors WHERE party_id = ${id}
    UNION SELECT composition_id FROM recordings WHERE composition_id IS NOT NULL AND id IN (${credited})`);
  const takes = await tx.all<{ id: string }>(
    sql`SELECT id FROM recordings WHERE composition_id IS NULL AND id IN (${credited})`,
  );
  for (const song of songs) await reindexSong(tx, song.id);
  for (const take of takes) await reindexRecording(tx, take.id);
}

/** The party as getParty reads it after the write commits. */
const partyOf = (tenant: TenantContext, written: ServiceResult<string>) =>
  written.ok ? getParty(tenant, written.value) : written;

/**
 * Creates a person or an organization with its subtype row (§4.2, D-5) in one audited write.
 * contact:create (§6.2) and VALIDATION come first, before the database opens. `legalName` defaults
 * to the display name. Audits party.create (D-4), then returns the PartyDetailDTO.
 */
export async function createParty(
  tenant: TenantContext,
  input: PartyInput,
): Promise<ServiceResult<PartyDetailDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input, true);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const [id, at, name] = [`pty_${ulid()}`, new Date().toISOString(), input.displayName.trim()];
    await guard.insert(tx, parties, [
      {
        ...{ id, partyKind: input.partyKind, displayName: name, notes: input.notes ?? null },
        ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
      },
    ]);
    const { table, row } = subtypeOf(id, input.partyKind, name, input);
    await guard.insert(tx, table, [row]);
    await audit.write({
      ...{ action: 'party.create', entityType: 'party', entityId: id },
      ...{ before: null, after: (await load(tx, id)) ?? null },
    });
    return success(id);
  });
  return partyOf(tenant, written);
}

/**
 * Applies `patch` to a live party (§4.2, D-5) in one audited write. contact:update and VALIDATION
 * come first; a party with no live row is NOT_FOUND. A kind change replaces the subtype row and is
 * REFERENCED, with counts, while a kind-checked row holds the party (§4.4 rule 1). A rename
 * reindexes the songs that credit the party (G-13). A patch that changes nothing writes nothing;
 * otherwise audits party.update before and after (D-4).
 */
export async function updateParty(
  tenant: TenantContext,
  partyId: string,
  patch: PartyPatch,
): Promise<ServiceResult<PartyDetailDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(patch, false);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const before = await load(tx, partyId);
    if (!before) return failure('NOT_FOUND');
    const kind = patch.partyKind ?? before.partyKind;
    const name = patch.displayName?.trim() ?? before.displayName;
    const notes = patch.notes === undefined ? before.notes : patch.notes;
    if (kind !== before.partyKind) {
      const counts = await kindReferences(tx, partyId);
      if (Object.keys(counts).length) return failure({ code: 'REFERENCED', counts });
    }
    const { table, row } = subtypeOf(partyId, kind, name, patch, before);
    const held = kind === 'person' ? before.person : before.organization;
    const party = { partyKind: kind, displayName: name, notes };
    const same = (a: object, b: object | null) =>
      b !== null && Object.entries(a).every(([key, value]) => b[key as keyof typeof b] === value);
    if (same(party, before) && same(row, held)) return success(partyId);
    const self = eq(parties.id, partyId);
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
    if (kind !== before.partyKind) {
      const old = before.partyKind === 'person' ? people : organizations;
      await guard.delete(tx, old, eq(old.partyId, partyId));
      await guard.update(tx, parties, { ...party, ...stamp }, self);
      await guard.insert(tx, table, [row]);
    } else {
      await guard.update(tx, parties, { ...party, ...stamp }, self);
      await guard.update(tx, table, row, eq(table.partyId, partyId));
    }
    if (name !== before.displayName) await reindexCredits(tx, partyId);
    await audit.write({
      ...{ action: 'party.update', entityType: 'party', entityId: partyId },
      ...{ before, after: (await load(tx, partyId)) ?? null },
    });
    return success(partyId);
  });
  return partyOf(tenant, written);
}

/**
 * Soft-deletes a live party (§4.2) in one audited write. contact:delete (§6.2: owners and admins);
 * a party with no live row is NOT_FOUND; one a live row still references through a RESTRICT rule,
 * such as a share, an agreement or a credit, is REFERENCED with counts (rule 2). Audits party.delete.
 */
export async function deleteParty(
  tenant: TenantContext,
  partyId: string,
): Promise<ServiceResult<{ partyId: string }>> {
  if (!requirePermission(tenant, DELETE).ok) return failure('FORBIDDEN');
  return runWorkspaceWrite(tenant, DELETE, async (tx, audit) => {
    const before = await load(tx, partyId);
    if (!before) return failure('NOT_FOUND');
    await guard.softDelete(tx, parties, eq(parties.id, partyId), tenant.userId);
    const [after] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, partyId), isNotNull(parties.deletedAt)));
    await audit.write({
      ...{ action: 'party.delete', entityType: 'party', entityId: partyId },
      ...{ before, after },
    });
    return success({ partyId });
  });
}
