import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { PartyContactDTO, PartyKind, PartyListItem } from '../../../lib/dto/contacts';
import {
  contactMethods,
  contactRoles,
  contacts,
  parties,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

/** contact:read for the role resolved for this request (§6.2, D-5); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { contact: ['read'] }).ok;

const PARTY = {
  partyId: parties.id,
  partyKind: sql<PartyKind>`${parties.partyKind}`,
  displayName: parties.displayName,
};

/** A contact's company: the parties table under a second name. */
const company = alias(parties, 'company');

/** Live contacts, one row per role in name order, each with its company while that is live. */
const contactRows = (database: WorkspaceDatabase) =>
  database
    .select({
      partyId: contacts.partyId,
      contactId: contacts.id,
      organizationPartyId: company.id,
      organizationName: company.displayName,
      role: contactRoles.role,
    })
    .from(contacts)
    .leftJoin(company, and(eq(company.id, contacts.organizationPartyId), isNull(company.deletedAt)))
    .leftJoin(contactRoles, eq(contactRoles.contactId, contacts.id))
    .where(isNull(contacts.deletedAt))
    .orderBy(asc(contactRoles.role));

type ContactRow = Awaited<ReturnType<typeof contactRows>>[number];

/** Contact rows folded into one PartyContactDTO per party. */
function contactsByParty(rows: ContactRow[]) {
  const byParty = new Map<string, PartyContactDTO>();
  for (const { partyId, role, ...contact } of rows) {
    const found = byParty.get(partyId) ?? { ...contact, roles: [] };
    if (role !== null) found.roles.push(role);
    byParty.set(partyId, found);
  }
  return byParty;
}

/**
 * The live parties at /people (§2.3), by case-insensitive name then id, each with its primary email
 * and its contact. `query` keeps the names that contain it, compared case-insensitively in
 * JavaScript. A refused role never opens the database; the reads share one batch, so one round trip.
 */
export async function listParties(
  tenant: TenantContext,
  { kind, query }: { kind?: PartyKind; query?: string } = {},
): Promise<ServiceResult<PartyListItem[]>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const reads = sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database.batch([
      database
        .select(PARTY)
        .from(parties)
        .where(and(isNull(parties.deletedAt), kind ? eq(parties.partyKind, kind) : undefined))
        .orderBy(asc(sql`lower(${parties.displayName})`), asc(parties.id)),
      database
        .select({ partyId: contactMethods.partyId, value: contactMethods.value })
        .from(contactMethods)
        .where(and(eq(contactMethods.methodType, 'email'), eq(contactMethods.isPrimary, 1)))
        .orderBy(desc(contactMethods.createdAt), desc(contactMethods.id)),
      contactRows(database),
    ]);
  });
  // Only the database work is sanitized, so a bug in the mapping throws as itself.
  return reads.then(([rows, emails, contactRead]) => {
    const needle = query?.trim().toLowerCase() ?? '';
    // Newest first, so the earliest primary email is the one the map keeps.
    const emailOf = new Map(emails.map(({ partyId, value }) => [partyId, value]));
    const contactOf = contactsByParty(contactRead);
    const named = rows.filter(({ displayName }) => displayName.toLowerCase().includes(needle));
    return success(
      named.map((party) => ({
        ...party,
        primaryEmail: emailOf.get(party.partyId) ?? null,
        contact: contactOf.get(party.partyId) ?? null,
      })),
    );
  });
}
