import { asc, eq } from 'drizzle-orm';
import { controlDb } from '../db/client';
import { member, organization } from '../db/schema/auth';

export type Membership = { organizationId: string; name: string; role: string };

/**
 * The workspaces a user is a member of, by name, with the user's role in each. Membership lives
 * only in Better Auth's `member` table (docs/CONTRACT.md §6.1); read on every call, never cached.
 */
export async function listMemberships(userId: string): Promise<Membership[]> {
  return controlDb
    .select({ organizationId: member.organizationId, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name));
}
