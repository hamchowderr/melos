import { asc, eq } from 'drizzle-orm';
import { isWorkspaceRole, type WorkspaceRole } from '../../lib/auth/permissions';
import { controlDb } from '../db/client';
import { member, organization } from '../db/schema/auth';

export type Membership = { organizationId: string; name: string; role: WorkspaceRole };

/**
 * The workspaces a user is a member of, by name, with the user's role in each. Membership lives
 * only in Better Auth's `member` table (docs/CONTRACT.md §6.1); read on every call, never cached.
 * A membership whose role TenantContextResolver refuses is left out, so it is never listed or
 * opened at sign-in.
 */
export async function listMemberships(userId: string): Promise<Membership[]> {
  const rows = await controlDb
    .select({ organizationId: member.organizationId, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name));
  // The resolver's check: one role per member; Better Auth joins several with commas (P-30).
  return rows.filter(
    (row): row is Membership => !row.role.includes(',') && isWorkspaceRole(row.role),
  );
}
