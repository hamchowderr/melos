import { and, asc, eq, inArray, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { ContactSearch, ContactSummary } from '../../../lib/dto/contacts';
import { CLOSED_STATUSES } from '../../../lib/dto/pitches';
import {
  contactRoles,
  contacts,
  parties,
  pitches,
  pitchItems,
  recordings,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

const company = sql`(select c.display_name from parties c
  where c.id = ${contacts.organizationPartyId} and c.deleted_at is null)`;
const primaryEmail = sql<string | null>`(select m.value from contact_methods m
  where m.party_id = ${contacts.partyId} and m.method_type = 'email' and m.is_primary = 1)`;

/** Contacts with a cell on the song; a composition covers the cells on its recordings. */
function pitchedFor(
  database: WorkspaceDatabase,
  { itemType, itemId }: NonNullable<ContactSearch['hasPitchFor']>,
) {
  const takes = database
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.compositionId, itemId));
  const cell =
    itemType === 'recording'
      ? eq(pitchItems.recordingId, itemId)
      : or(eq(pitchItems.compositionId, itemId), inArray(pitchItems.recordingId, takes));
  const pitched = database
    .select({ contactId: pitches.contactId })
    .from(pitchItems)
    .innerJoin(pitches, eq(pitches.id, pitchItems.pitchId))
    .where(cell);
  return inArray(contacts.id, pitched);
}

/** A case-insensitive substring of the name, the company or any email address (§3.3). */
function matching(query: string): SQL {
  const needle = query.toLowerCase();
  const email = sql`exists (select 1 from contact_methods m where m.party_id = ${contacts.partyId}
    and m.method_type = 'email' and instr(lower(m.value), ${needle}) > 0)`;
  return sql`(instr(lower(${parties.displayName}), ${needle}) > 0
    or instr(lower(coalesce(${company}, '')), ${needle}) > 0 or ${email})`;
}

/**
 * The live contacts (§3.3 searchContacts, CRM-001) matching every filter in ContactSearch, by
 * case-insensitive name then id. contact:read; a refused role never opens the database. A limit
 * outside 1..200 is VALIDATION.
 */
export async function searchContacts(
  tenant: TenantContext,
  search: ContactSearch = {},
): Promise<ServiceResult<ContactSummary[]>> {
  if (!requirePermission(tenant, { contact: ['read'] }).ok) return failure('FORBIDDEN');
  const limit = search.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return failure({ code: 'VALIDATION', field: 'limit', reason: 'range' });
  const query = search.query?.trim();
  const roles = search.roles?.map((role) => role.trim()).filter(Boolean);
  return sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const roleIds = database
      .select({ id: contactRoles.contactId })
      .from(contactRoles)
      .where(inArray(contactRoles.role, roles ?? []));
    const open = database
      .select({ n: sql<number>`count(*)` })
      .from(pitchItems)
      .innerJoin(pitches, eq(pitches.id, pitchItems.pitchId))
      .where(
        and(
          eq(pitches.contactId, contacts.id),
          notInArray(pitchItems.currentStatus, [...CLOSED_STATUSES]),
        ),
      );
    const rows = await database
      .select({
        contactId: contacts.id,
        partyId: contacts.partyId,
        displayName: parties.displayName,
        organizationPartyId: sql<
          string | null
        >`case when ${company} is null then null else ${contacts.organizationPartyId} end`,
        organizationName: sql<string | null>`${company}`,
        primaryEmail,
        openItemCount: sql<number>`(${open})`,
      })
      .from(contacts)
      .innerJoin(parties, eq(parties.id, contacts.partyId))
      .where(
        and(
          isNull(contacts.deletedAt),
          isNull(parties.deletedAt),
          query ? matching(query) : undefined,
          roles?.length ? inArray(contacts.id, roleIds) : undefined,
          search.hasPitchFor ? pitchedFor(database, search.hasPitchFor) : undefined,
        ),
      )
      .orderBy(asc(sql`lower(${parties.displayName})`), asc(contacts.id))
      .limit(limit);
    const roleRows = rows.length
      ? await database
          .select()
          .from(contactRoles)
          .where(
            inArray(
              contactRoles.contactId,
              rows.map((row) => row.contactId),
            ),
          )
          .orderBy(asc(contactRoles.role))
      : [];
    return success(
      rows.map((row) => ({
        ...row,
        roles: roleRows.filter((role) => role.contactId === row.contactId).map((role) => role.role),
        openItemCount: Number(row.openItemCount),
      })),
    );
  });
}
