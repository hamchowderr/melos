import { and, asc, type Column, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type {
  LinkedPersonDTO,
  PartyContactDTO,
  PartyDetailDTO,
  PartyKind,
  PartyListItem,
} from '../../../lib/dto/contacts';
import {
  artistAliases,
  contactMethods,
  contactRoles,
  contacts,
  organizations,
  parties,
  partyIdentifiers,
  partySocietyAffiliations,
  people,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

/** contact:read for the role resolved for this request (§6.2, D-5); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { contact: ['read'] }).ok;

const flag = (column: Column) => sql`${column} = 1`.mapWith(Boolean);

const PARTY = {
  partyId: parties.id,
  partyKind: sql<PartyKind>`${parties.partyKind}`,
  displayName: parties.displayName,
};

/** A contact's company: the parties table under a second name. */
const company = alias(parties, 'company');

/** Live contacts, one row per role in name order, each with its company while that is live. */
const contactRows = (database: WorkspaceDatabase, where?: SQL) =>
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
    .where(and(isNull(contacts.deletedAt), where))
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
 * and its contact. An organization also carries its type and the live people whose live contact
 * links to it, by name. `kind` and `query` (names that contain it, ignoring case) filter in
 * JavaScript, so those people are listed whatever the filter. A refused role never opens the
 * database; the reads share one batch, so one round trip.
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
        .select({ ...PARTY, organizationType: organizations.organizationType })
        .from(parties)
        .leftJoin(organizations, eq(organizations.partyId, parties.id))
        .where(isNull(parties.deletedAt))
        .orderBy(asc(sql`lower(${parties.displayName})`), asc(parties.id)),
      database
        .select({ partyId: contactMethods.partyId, value: contactMethods.value })
        .from(contactMethods)
        // uq_contact_methods_primary allows one primary email per party (§4.3).
        .where(and(eq(contactMethods.methodType, 'email'), eq(contactMethods.isPrimary, 1))),
      contactRows(database),
    ]);
  });
  // Only the database work is sanitized, so a bug in the mapping throws as itself.
  return reads.then(([rows, emails, contactRead]) => {
    const needle = query?.trim().toLowerCase() ?? '';
    const emailOf = new Map(emails.map(({ partyId, value }) => [partyId, value]));
    const contactOf = contactsByParty(contactRead);
    // Rows are live and in name order; a contact's company is set only while it is live.
    const peopleOf = new Map<string, LinkedPersonDTO[]>();
    for (const { partyId, partyKind, displayName } of rows) {
      const organizationId = contactOf.get(partyId)?.organizationPartyId;
      if (partyKind !== 'person' || !organizationId) continue;
      const linked = peopleOf.get(organizationId) ?? [];
      linked.push({ partyId, displayName });
      peopleOf.set(organizationId, linked);
    }
    const listed = rows.filter(
      ({ partyKind, displayName }) =>
        (!kind || partyKind === kind) && displayName.toLowerCase().includes(needle),
    );
    return success(
      listed.map(({ organizationType, ...party }) => ({
        ...party,
        primaryEmail: emailOf.get(party.partyId) ?? null,
        contact: contactOf.get(party.partyId) ?? null,
        ...(party.partyKind === 'organization'
          ? { organizationType, people: peopleOf.get(party.partyId) ?? [] }
          : {}),
      })),
    );
  });
}

/**
 * One live party with its subtype fields, contact methods (primary first), artist aliases,
 * identifiers with the alias each belongs to, society affiliations and contact. An id with no live
 * party in the tenant's own database is NOT_FOUND, so an id from another workspace never resolves
 * (TEN-001). A refused role never opens the database; the reads share one batch.
 */
export async function getParty(
  tenant: TenantContext,
  partyId: string,
): Promise<ServiceResult<PartyDetailDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const reads = sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database.batch([
      database
        .select({
          ...PARTY,
          notes: parties.notes,
          // drizzle nulls a left-joined object when its first column is NULL: legalName is NOT NULL.
          person: {
            legalName: people.legalName,
            givenName: people.givenName,
            familyName: people.familyName,
          },
          organization: {
            legalName: organizations.legalName,
            organizationType: organizations.organizationType,
            websiteUrl: organizations.websiteUrl,
          },
        })
        .from(parties)
        .leftJoin(people, eq(people.partyId, parties.id))
        .leftJoin(organizations, eq(organizations.partyId, parties.id))
        .where(and(eq(parties.id, partyId), isNull(parties.deletedAt))),
      database
        .select({
          ...{ id: contactMethods.id, methodType: contactMethods.methodType },
          ...{ label: contactMethods.label, value: contactMethods.value },
          isPrimary: flag(contactMethods.isPrimary),
        })
        .from(contactMethods)
        .where(eq(contactMethods.partyId, partyId))
        .orderBy(
          desc(contactMethods.isPrimary),
          asc(contactMethods.methodType),
          asc(contactMethods.createdAt),
          asc(contactMethods.id),
        ),
      database
        .select({
          ...{ id: artistAliases.id, aliasName: artistAliases.aliasName },
          ...{ aliasType: artistAliases.aliasType, isPrimary: flag(artistAliases.isPrimary) },
        })
        .from(artistAliases)
        .where(eq(artistAliases.partyId, partyId))
        .orderBy(desc(artistAliases.isPrimary), asc(artistAliases.aliasName)),
      database
        .select({
          id: partyIdentifiers.id,
          identifierType: partyIdentifiers.identifierType,
          identifierValue: partyIdentifiers.identifierValue,
          issuingBody: partyIdentifiers.issuingBody,
          isPrimary: flag(partyIdentifiers.isPrimary),
          artistAliasId: partyIdentifiers.artistAliasId,
          aliasName: artistAliases.aliasName,
        })
        .from(partyIdentifiers)
        .leftJoin(artistAliases, eq(artistAliases.id, partyIdentifiers.artistAliasId))
        .where(eq(partyIdentifiers.partyId, partyId))
        .orderBy(
          desc(partyIdentifiers.isPrimary),
          asc(partyIdentifiers.identifierType),
          asc(partyIdentifiers.identifierValue),
        ),
      database
        .select({
          ...{ id: partySocietyAffiliations.id, societyCode: partySocietyAffiliations.societyCode },
          ...{ role: partySocietyAffiliations.role, startsOn: partySocietyAffiliations.startsOn },
          endsOn: partySocietyAffiliations.endsOn,
        })
        .from(partySocietyAffiliations)
        .where(eq(partySocietyAffiliations.partyId, partyId))
        .orderBy(asc(partySocietyAffiliations.societyCode), asc(partySocietyAffiliations.id)),
      contactRows(database, eq(contacts.partyId, partyId)),
    ]);
  });
  // Only the database work is sanitized, so a bug in the mapping throws as itself.
  return reads.then(
    ([[party], methods, aliases, identifiers, societyAffiliations, contactRead]) => {
      if (!party) return failure('NOT_FOUND');
      const contact = contactsByParty(contactRead).get(partyId) ?? null;
      return success({ ...party, methods, aliases, identifiers, societyAffiliations, contact });
    },
  );
}

/** An artist alias with its party, for the recording artist picker (CAT-003). */
export type AliasOption = { id: string; partyId: string; aliasName: string };

/** Every live party's artist aliases (CAT-008), by name, for contact:read. One batch. */
export async function listArtistAliases(
  tenant: TenantContext,
): Promise<ServiceResult<AliasOption[]>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const [rows] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { id, partyId, aliasName } = artistAliases;
    return database.batch([
      database
        .select({ id, partyId, aliasName })
        .from(artistAliases)
        .innerJoin(parties, and(eq(parties.id, partyId), isNull(parties.deletedAt)))
        .orderBy(asc(aliasName), asc(id)),
    ]);
  });
  return success(rows);
}
