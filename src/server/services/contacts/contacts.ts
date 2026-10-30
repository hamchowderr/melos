import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { ContactDetailDTO, ContactInput, ContactPatch } from '../../../lib/dto/contacts';
import { contactRoles, contacts, parties } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { insertParty, invalidParty } from './parties';
import { getParty } from './read';

const CREATE: WorkspacePermissions = { contact: ['create'] };
const UPDATE: WorkspacePermissions = { contact: ['update'] };
const DELETE: WorkspacePermissions = { contact: ['delete'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/** Roles as stored: trimmed, without repeats, in input order. */
const rolesOf = (roles: string[]) => [...new Set(roles.map((role) => role.trim()))];

/** VALIDATION for the contact's own fields, before the database opens. */
function invalid(fields: ContactPatch): ServiceResult<never> | null {
  if (fields.roles?.some((role) => !role?.trim())) return refuse('roles', 'required');
  return null;
}

/** A live contact row with its roles, read in the write transaction for the audit log. */
async function load(tx: WorkspaceTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)));
  if (!row) return undefined;
  const roles = await tx
    .select({ role: contactRoles.role })
    .from(contactRoles)
    .where(eq(contactRoles.contactId, id))
    .orderBy(asc(contactRoles.role));
  return { ...row, roles: roles.map(({ role }) => role) };
}

/** NOT_FOUND for a company with no live party, VALIDATION for a person (§4.3). */
async function companyRefusal(tx: WorkspaceTransaction, organizationPartyId?: string | null) {
  if (!organizationPartyId) return null;
  const live = and(eq(parties.id, organizationPartyId), isNull(parties.deletedAt));
  const [company] = await tx.select({ kind: parties.partyKind }).from(parties).where(live);
  if (!company) return failure('NOT_FOUND');
  return company.kind === 'organization'
    ? null
    : refuse('organizationPartyId', 'organization_required');
}

/** Stores `roles` as the contact's whole role set. */
async function replaceRoles(tx: WorkspaceTransaction, contactId: string, roles: string[]) {
  await guard.delete(tx, contactRoles, eq(contactRoles.contactId, contactId));
  if (roles.length)
    await guard.insert(
      tx,
      contactRoles,
      roles.map((role) => ({ contactId, role })),
    );
}

/**
 * ContactDetailDTO for a live contact (§3.4), for contact:read. A refused role never opens the
 * database; an id with no live contact in the tenant's own database is NOT_FOUND.
 */
export async function getContact(
  tenant: TenantContext,
  contactId: string,
): Promise<ServiceResult<ContactDetailDTO>> {
  if (!requirePermission(tenant, { contact: ['read'] }).ok) return failure('FORBIDDEN');
  const [row] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { partyId, relationshipNotes, active } = contacts;
    return database
      .select({ partyId, relationshipNotes, active })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
  });
  if (!row) return failure('NOT_FOUND');
  const party = await getParty(tenant, row.partyId);
  if (!party.ok) return party;
  const { displayName, contact, methods } = party.value;
  const email = methods.find((method) => method.methodType === 'email' && method.isPrimary);
  return success({
    ...{ contactId, partyId: row.partyId, displayName },
    organizationPartyId: contact?.organizationPartyId ?? null,
    organizationName: contact?.organizationName ?? null,
    ...{ roles: contact?.roles ?? [], primaryEmail: email?.value ?? null, openItemCount: 0 },
    ...{ relationshipNotes: row.relationshipNotes, active: row.active === 1, methods },
    ...{ pitchItems: [], recentMessages: [] },
  });
}

/**
 * Creates a contact (CRM-001) for an existing party or, in the same write, a new one, which audits
 * its own party.create. contact:create and VALIDATION come first. A party or company with no live
 * row is NOT_FOUND, a person as company VALIDATION, and a second live contact for the party
 * CONFLICT (P-09). Audits contact.create with the row and roles (D-4).
 */
export async function createContact(
  tenant: TenantContext,
  input: ContactInput,
): Promise<ServiceResult<ContactDetailDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  if ((input.partyId === undefined) === (input.party === undefined))
    return refuse('partyId', 'exactly_one_of_party_or_party_id');
  const refused = invalid(input) ?? (input.party ? invalidParty(input.party) : null);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const company = await companyRefusal(tx, input.organizationPartyId);
    if (company) return company;
    let partyId = input.partyId ?? '';
    if (input.party) partyId = await insertParty(tx, audit, tenant, input.party);
    else {
      const live = and(eq(parties.id, partyId), isNull(parties.deletedAt));
      if (!(await tx.select({ id: parties.id }).from(parties).where(live)).length)
        return failure('NOT_FOUND');
      const held = and(eq(contacts.partyId, partyId), isNull(contacts.deletedAt));
      if ((await tx.select({ id: contacts.id }).from(contacts).where(held)).length)
        return failure({ code: 'CONFLICT', field: 'partyId' });
    }
    const [id, at, by] = [`con_${ulid()}`, new Date().toISOString(), tenant.userId];
    await guard.insert(tx, contacts, [
      {
        ...{ id, partyId, organizationPartyId: input.organizationPartyId ?? null },
        ...{ relationshipNotes: input.relationshipNotes ?? null },
        ...{ createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
      },
    ]);
    await replaceRoles(tx, id, rolesOf(input.roles ?? []));
    await audit.write({
      ...{ action: 'contact.create', entityType: 'contact', entityId: id },
      ...{ before: null, after: (await load(tx, id)) ?? null },
    });
    return success(id);
  });
  return written.ok ? getContact(tenant, written.value) : written;
}

/**
 * Applies `patch` to a live contact in one audited write. contact:update and VALIDATION come
 * first; a contact or company with no live row is NOT_FOUND, a person as company VALIDATION. A
 * patch that changes nothing writes nothing; otherwise audits contact.update before and after.
 */
export async function updateContact(
  tenant: TenantContext,
  contactId: string,
  patch: ContactPatch,
): Promise<ServiceResult<ContactDetailDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(patch);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const before = await load(tx, contactId);
    if (!before) return failure('NOT_FOUND');
    const company = await companyRefusal(tx, patch.organizationPartyId);
    if (company) return company;
    const row = {
      organizationPartyId:
        patch.organizationPartyId === undefined
          ? before.organizationPartyId
          : patch.organizationPartyId,
      relationshipNotes:
        patch.relationshipNotes === undefined ? before.relationshipNotes : patch.relationshipNotes,
      active: patch.active === undefined ? before.active : patch.active ? 1 : 0,
    };
    const roles = patch.roles ? rolesOf(patch.roles) : before.roles;
    const sameRoles = [...roles].sort().join('\n') === before.roles.join('\n');
    const same = Object.entries(row).every(
      ([key, value]) => before[key as keyof typeof row] === value,
    );
    if (same && sameRoles) return success(contactId);
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
    await guard.update(tx, contacts, { ...row, ...stamp }, eq(contacts.id, contactId));
    if (!sameRoles) await replaceRoles(tx, contactId, roles);
    await audit.write({
      ...{ action: 'contact.update', entityType: 'contact', entityId: contactId },
      ...{ before, after: (await load(tx, contactId)) ?? null },
    });
    return success(contactId);
  });
  return written.ok ? getContact(tenant, written.value) : written;
}

/**
 * Soft-deletes a live contact (§4.2). contact:delete (owners and admins); a contact a live pitch
 * still references is REFERENCED with counts (§4.4 rule 2). Audits contact.delete.
 */
export async function deleteContact(
  tenant: TenantContext,
  contactId: string,
): Promise<ServiceResult<{ contactId: string }>> {
  if (!requirePermission(tenant, DELETE).ok) return failure('FORBIDDEN');
  return runWorkspaceWrite(tenant, DELETE, async (tx, audit) => {
    const before = await load(tx, contactId);
    if (!before) return failure('NOT_FOUND');
    await guard.softDelete(tx, contacts, eq(contacts.id, contactId), tenant.userId);
    const [after] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNotNull(contacts.deletedAt)));
    await audit.write({
      ...{ action: 'contact.delete', entityType: 'contact', entityId: contactId },
      ...{ before, after },
    });
    return success({ contactId });
  });
}
