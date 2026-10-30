import { and, asc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  ALIAS_TYPES,
  type ArtistAliasInput,
  IDENTIFIER_TYPES,
  type PartyDetailDTO,
  type PartyIdentifierInput,
  type SocietyAffiliationInput,
} from '../../../lib/dto/contacts';
import { normalizeIpi } from '../../../lib/identifiers';
import {
  partySocietyAffiliations as affiliations,
  artistAliases as aliases,
  partyIdentifiers as identifiers,
  parties,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { isCalendarDate } from '../rights/agreements';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getParty } from './read';

/** contact:update covers aliases (D-5) and, as melos-rpr.9's review implied, identifiers too. */
const UPDATE: WorkspacePermissions = { contact: ['update'] };

type Child = typeof aliases | typeof identifiers | typeof affiliations;
type Field = 'aliases' | 'identifiers' | 'societyAffiliations';
type Refusal = ServiceResult<never> | null;

const refuse = (field: Field, reason: string) => failure({ code: 'VALIDATION', field, reason });
const primaries = (rows: { isPrimary?: boolean }[]) => rows.filter((row) => row.isPrimary).length;

/**
 * Replaces one of a live party's child sets (CAT-008) in one audited write: an input `id` keeps
 * that row and updates it, a held row the set leaves out is deleted through the guard (its SET NULL
 * rules apply), the rest are inserted. contact:update comes first, and `refused` (VALIDATION)
 * before the database opens. A party with no live row, or an `id` that is not one of its rows, is
 * NOT_FOUND; `check` adds a refusal that needs the database. A set that changes nothing writes
 * nothing; otherwise audits party.update with the set before and after.
 */
async function replaceSet<R extends { id?: string }>(
  tenant: TenantContext,
  partyId: string,
  child: { table: Child; field: Field; rows: R[]; refused: Refusal } & {
    columns: (row: R) => Record<string, unknown>;
    check?: (tx: WorkspaceTransaction) => Promise<Refusal>;
  },
): Promise<ServiceResult<PartyDetailDTO>>;
async function replaceSet(
  tenant: TenantContext,
  partyId: string,
  child: {
    table: Child;
    field: Field;
    rows: { id?: string }[];
    refused: Refusal;
    columns: (row: never) => Record<string, unknown>;
    check?: (tx: WorkspaceTransaction) => Promise<Refusal>;
  },
): Promise<ServiceResult<PartyDetailDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  if (child.refused) return child.refused;
  const table = child.table as typeof aliases;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(parties.id, partyId), isNull(parties.deletedAt));
    if (!(await tx.select({ id: parties.id }).from(parties).where(live)).length)
      return failure('NOT_FOUND');
    const setOf = () =>
      tx.select().from(table).where(eq(table.partyId, partyId)).orderBy(asc(table.id));
    const before: Record<string, unknown>[] = await setOf();
    const held = new Map(before.map((row) => [row.id as string, row]));
    if (child.rows.some(({ id }) => id && !held.has(id))) return failure('NOT_FOUND');
    const refused = await child.check?.(tx);
    if (refused) return refused;
    const next = monotonicFactory();
    const rows = child.rows.map((row) => ({
      id: row.id ?? next(),
      ...child.columns(row as never),
    }));
    const same = (row: (typeof rows)[number]) =>
      Object.entries(row).every(([key, value]) => held.get(row.id)?.[key] === value);
    if (rows.length === before.length && rows.every(same)) return success(partyId);
    const kept = rows.flatMap(({ id }) => (held.has(id) ? [id] : []));
    const mine = eq(table.partyId, partyId);
    await guard.delete(tx, table, and(mine, notInArray(table.id, kept)) ?? mine);
    for (const { id, ...set } of rows.filter(({ id }) => held.has(id)))
      await guard.update(tx, table, set as never, eq(table.id, id));
    const added = rows.filter(({ id }) => !held.has(id));
    const stamp = { partyId, createdAt: new Date().toISOString(), createdBy: tenant.userId };
    if (added.length)
      await guard.insert(tx, table, added.map((row) => ({ ...row, ...stamp })) as never);
    await audit.write({
      ...{ action: 'party.update', entityType: 'party', entityId: partyId },
      ...{ before: { [child.field]: before }, after: { [child.field]: await setOf() } },
    });
    return success(partyId);
  });
  return written.ok ? getParty(tenant, written.value) : written;
}

/** VALIDATION for an alias set: a name, a known type, unique names and at most one primary. */
function invalidAliases(rows: ArtistAliasInput[]): Refusal {
  if (rows.some(({ aliasName }) => !aliasName?.trim())) return refuse('aliases', 'required');
  if (rows.some(({ aliasType }) => aliasType !== undefined && !ALIAS_TYPES.includes(aliasType)))
    return refuse('aliases', 'unknown_alias_type');
  if (new Set(rows.map((row) => row.aliasName.trim())).size < rows.length)
    return refuse('aliases', 'duplicate_alias');
  return primaries(rows) > 1 ? refuse('aliases', 'more_than_one_primary') : null;
}

/**
 * Replaces a party's artist aliases (CAT-008). Deleting an alias sets recording_artists and
 * party_identifiers alias ids to NULL through the guard (§4.4).
 */
export const setArtistAliases = (
  tenant: TenantContext,
  partyId: string,
  rows: ArtistAliasInput[],
) =>
  replaceSet(tenant, partyId, {
    ...{ table: aliases, field: 'aliases', rows, refused: invalidAliases(rows) },
    columns: (row: ArtistAliasInput) => ({
      ...{ aliasName: row.aliasName.trim(), aliasType: row.aliasType ?? 'stage_name' },
      isPrimary: row.isPrimary ? 1 : 0,
    }),
  });

const isIpi = (type: string): type is 'IPI' | 'IPI_BASE' => type === 'IPI' || type === 'IPI_BASE';

/** An IPI as normalizeIpi stores it (§4.4), else the value trimmed and upper-cased. */
function storedValue(row: PartyIdentifierInput) {
  const value = row.identifierValue.trim().toUpperCase();
  const ipi = isIpi(row.identifierType) ? normalizeIpi(value, row.identifierType) : undefined;
  return ipi?.ok ? ipi.value : value;
}

/** VALIDATION for an identifier set: a value, a known type, no repeats, one primary per type. */
function invalidIdentifiers(rows: PartyIdentifierInput[]): Refusal {
  if (rows.some((row) => !row.identifierValue?.trim())) return refuse('identifiers', 'required');
  if (rows.some(({ identifierType }) => !IDENTIFIER_TYPES.includes(identifierType)))
    return refuse('identifiers', 'unknown_identifier_type');
  const keys = rows.map((row) => `${row.identifierType}|${storedValue(row)}`);
  if (new Set(keys).size < keys.length) return refuse('identifiers', 'duplicate_identifier');
  const typed = IDENTIFIER_TYPES.some(
    (type) => primaries(rows.filter((row) => row.identifierType === type)) > 1,
  );
  return typed ? refuse('identifiers', 'more_than_one_primary') : null;
}

/**
 * Replaces a party's identifiers. An alias must be one of the party's own (VALIDATION); a new or
 * changed IPI that normalizeIpi refuses is INVALID_IPI (P-46); a type and value another party
 * already holds is CONFLICT, before uq on (type, value) refuses the write.
 */
export const setPartyIdentifiers = (
  tenant: TenantContext,
  partyId: string,
  rows: PartyIdentifierInput[],
) =>
  replaceSet(tenant, partyId, {
    ...{ table: identifiers, field: 'identifiers', rows, refused: invalidIdentifiers(rows) },
    columns: (row: PartyIdentifierInput) => ({
      ...{ identifierType: row.identifierType, identifierValue: storedValue(row) },
      ...{ issuingBody: row.issuingBody ?? null, artistAliasId: row.artistAliasId ?? null },
      isPrimary: row.isPrimary ? 1 : 0,
    }),
    check: async (tx) => {
      const named = rows.flatMap(({ artistAliasId }) => (artistAliasId ? [artistAliasId] : []));
      const own = named.length
        ? await tx
            .select({ id: aliases.id })
            .from(aliases)
            .where(and(inArray(aliases.id, named), eq(aliases.partyId, partyId)))
        : [];
      if (own.length < new Set(named).size) return refuse('identifiers', 'alias_of_other_party');
      // Like ISWC, an IPI the party already holds passes unchecked; a new or changed one must parse.
      const held = await tx
        .select({ type: identifiers.identifierType, value: identifiers.identifierValue })
        .from(identifiers)
        .where(eq(identifiers.partyId, partyId));
      for (const row of rows) {
        if (!isIpi(row.identifierType)) continue;
        const value = storedValue(row);
        const parsed = normalizeIpi(value, row.identifierType);
        const kept = held.some((h) => h.type === row.identifierType && h.value === value);
        if (!parsed.ok && !kept)
          return failure({
            code: 'INVALID_IPI',
            field: 'identifiers',
            reason: parsed.error.reason,
          });
      }
      for (const row of rows) {
        const taken = and(
          eq(identifiers.identifierType, row.identifierType),
          eq(identifiers.identifierValue, storedValue(row)),
          ne(identifiers.partyId, partyId),
        );
        if ((await tx.select({ id: identifiers.id }).from(identifiers).where(taken)).length)
          return failure({ code: 'CONFLICT', field: 'identifiers' });
      }
      return null;
    },
  });

/** VALIDATION for an affiliation set: a society code, a known role and ordered calendar dates. */
function invalidAffiliations(rows: SocietyAffiliationInput[]): Refusal {
  const field = 'societyAffiliations';
  if (rows.some(({ societyCode }) => !societyCode?.trim())) return refuse(field, 'required');
  if (rows.some(({ role }) => role != null && role !== 'writer' && role !== 'publisher'))
    return refuse(field, 'unknown_role');
  const dates = rows.flatMap(({ startsOn, endsOn }) => [startsOn, endsOn]);
  if (dates.some((date) => date != null && !isCalendarDate(date)))
    return refuse(field, 'not_a_date');
  const backwards = rows.some(({ startsOn, endsOn }) => startsOn && endsOn && startsOn > endsOn);
  return backwards ? refuse(field, 'ends_before_start') : null;
}

/** Replaces a party's society affiliations (BP §11.3); society codes are not constrained. */
export const setSocietyAffiliations = (
  tenant: TenantContext,
  partyId: string,
  rows: SocietyAffiliationInput[],
) =>
  replaceSet(tenant, partyId, {
    ...{ table: affiliations, field: 'societyAffiliations', rows },
    refused: invalidAffiliations(rows),
    columns: (row: SocietyAffiliationInput) => ({
      ...{ societyCode: row.societyCode.trim().toUpperCase(), role: row.role ?? null },
      ...{ startsOn: row.startsOn ?? null, endsOn: row.endsOn ?? null },
    }),
  });
