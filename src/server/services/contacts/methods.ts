import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  type ContactMethodInput,
  METHOD_TYPES,
  type PartyDetailDTO,
  type PartyMatch,
} from '../../../lib/dto/contacts';
import { contactMethods, parties } from '../../db/schema/workspace.generated';
import { normalizeTitle } from '../catalog/read';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getParty } from './read';

const UPDATE: WorkspacePermissions = { contact: ['update'] };

const refuse = (reason: string) => failure({ code: 'VALIDATION', field: 'methods', reason });

/** A method value as stored and compared: trimmed, and an email lowercased. */
const storedValue = ({ methodType, value }: Pick<ContactMethodInput, 'methodType' | 'value'>) =>
  methodType === 'email' ? value.trim().toLowerCase() : value.trim();

/** VALIDATION for the first broken method, before the database opens. */
function invalid(methods: ContactMethodInput[]): ServiceResult<never> | null {
  if (methods.some(({ methodType }) => !METHOD_TYPES.includes(methodType)))
    return refuse('unknown_method_type');
  if (methods.some(({ value }) => !value?.trim())) return refuse('required');
  const primaries = methods.filter(({ isPrimary }) => isPrimary).map((m) => m.methodType);
  if (new Set(primaries).size < primaries.length) return refuse('more_than_one_primary');
  const ids = methods.flatMap(({ id }) => (id ? [id] : []));
  if (new Set(ids).size < ids.length) return refuse('duplicate_id');
  return null;
}

/** A party's methods in stored order, read in the write transaction for the audit log. */
const methodsOf = (tx: WorkspaceTransaction, partyId: string) => {
  const { id, methodType, label, value, isPrimary } = contactMethods;
  return tx
    .select({ id, methodType, label, value, isPrimary })
    .from(contactMethods)
    .where(eq(contactMethods.partyId, partyId))
    .orderBy(asc(contactMethods.id));
};

/**
 * Replaces a live party's contact methods with `methods` (§4.2, D-5) in one audited write:
 * contact:update and VALIDATION come first, before the database opens; a party with no live row,
 * or an `id` that is not one of its methods, is NOT_FOUND. A method left out is deleted through
 * the guard, so a message recipient that named it keeps its address snapshot and loses the link.
 * A set that changes nothing writes nothing; otherwise audits party.update with the methods.
 */
export async function setContactMethods(
  tenant: TenantContext,
  partyId: string,
  methods: ContactMethodInput[],
): Promise<ServiceResult<PartyDetailDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(methods);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(parties.id, partyId), isNull(parties.deletedAt));
    if (!(await tx.select({ id: parties.id }).from(parties).where(live)).length)
      return failure('NOT_FOUND');
    const before = await methodsOf(tx, partyId);
    const held = new Map(before.map((row) => [row.id, row]));
    if (methods.some(({ id }) => id && !held.has(id))) return failure('NOT_FOUND');
    const next = monotonicFactory();
    const rows = methods.map((method) => ({
      ...{ id: method.id ?? next(), methodType: method.methodType, label: method.label ?? null },
      ...{ value: storedValue(method), isPrimary: method.isPrimary ? 1 : 0 },
    }));
    const unchanged =
      rows.length === before.length &&
      rows.every((row) => {
        const old = held.get(row.id);
        return (
          old && Object.entries(row).every(([key, value]) => old[key as keyof typeof old] === value)
        );
      });
    if (unchanged) return success(partyId);
    const kept = rows.flatMap((row) => (held.has(row.id) ? [row.id] : []));
    const mine = eq(contactMethods.partyId, partyId);
    await guard.delete(tx, contactMethods, and(mine, notInArray(contactMethods.id, kept)) ?? mine);
    const [at, by] = [new Date().toISOString(), tenant.userId];
    // A row that stops being primary goes first, so uq_contact_methods_primary never sees two.
    for (const row of [...rows].sort((a, b) => a.isPrimary - b.isPrimary)) {
      if (held.has(row.id))
        await guard.update(
          tx,
          contactMethods,
          { ...row, updatedAt: at, updatedBy: by },
          eq(contactMethods.id, row.id),
        );
      else
        await guard.insert(tx, contactMethods, [
          { ...row, partyId, createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
        ]);
    }
    await audit.write({
      ...{ action: 'party.update', entityType: 'party', entityId: partyId },
      ...{ before: { methods: before }, after: { methods: await methodsOf(tx, partyId) } },
    });
    return success(partyId);
  });
  return written.ok ? getParty(tenant, written.value) : written;
}

/**
 * Live parties whose display name normalizes (§3.5) to the same text as `query.displayName`, or
 * that hold `query.email` as an email method: the createContact approval trigger and the possible
 * duplicate warning (§6.15). contact:read (§6.2); a refused role never opens the database.
 */
export async function findMatchingParties(
  tenant: TenantContext,
  query: { displayName?: string; email?: string },
): Promise<ServiceResult<PartyMatch[]>> {
  if (!requirePermission(tenant, { contact: ['read'] }).ok) return failure('FORBIDDEN');
  const name = query.displayName?.trim() ? normalizeTitle(query.displayName) : undefined;
  const email = query.email?.trim()
    ? storedValue({ methodType: 'email', value: query.email })
    : undefined;
  if (!name && !email) return success([]);
  const [rows, emails] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { id: partyId, partyKind, displayName } = parties;
    return database.batch([
      database
        .select({ partyId, partyKind, displayName })
        .from(parties)
        .where(isNull(parties.deletedAt))
        .orderBy(asc(parties.displayName), asc(parties.id)),
      database
        .select({ partyId: contactMethods.partyId })
        .from(contactMethods)
        .where(
          and(
            eq(contactMethods.methodType, 'email'),
            eq(sql`lower(trim(${contactMethods.value}))`, email ?? ''),
          ),
        ),
    ]);
  });
  const byEmail = new Set(emails.map((row) => row.partyId));
  return success(
    rows.flatMap((row) => {
      const matchedOn = [
        ...(name && normalizeTitle(row.displayName) === name ? (['name'] as const) : []),
        ...(email && byEmail.has(row.partyId) ? (['email'] as const) : []),
      ];
      return matchedOn.length
        ? [{ ...row, partyKind: row.partyKind as PartyMatch['partyKind'], matchedOn }]
        : [];
    }),
  );
}
