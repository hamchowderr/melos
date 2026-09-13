import { and, eq } from 'drizzle-orm';
import { isWorkspaceRole, type WorkspaceRole } from '../../lib/auth/permissions';
import { auth } from '../auth/auth';
import { controlDb } from '../db/client';
import { member } from '../db/schema/auth';

/** Who is calling, in which workspace, with which role (docs/CONTRACT.md §7.1 step 2.4). */
export type TenantContext = {
  userId: string;
  organizationId: string;
  workspaceRole: WorkspaceRole;
  requestId: string;
};

export type TenantResolution =
  | { status: 'ok'; context: TenantContext }
  | { status: 'unauthenticated' | 'no-active-workspace' | 'not-a-member' | 'invalid-role' };

/** Derives who is calling and which workspace they act in. Never trusts client input. */
export interface TenantContextResolver {
  resolve(headers: Headers): Promise<TenantResolution>;
}

/**
 * docs/CONTRACT.md §7.1 steps 1, 2.1, 2.2 and 2.4. The session and the member row are read on
 * every request and never cached, so a removed member or a changed role applies to the next
 * request. A null active workspace is never defaulted to another workspace. The
 * workspace_registry lookup and workspaceId (step 2.3) arrive with WorkspaceProvisioner.
 */
export const tenantContextResolver: TenantContextResolver = {
  async resolve(headers) {
    const session = await auth.api.getSession({ headers });
    if (!session) return { status: 'unauthenticated' };

    const userId = session.user.id;
    const organizationId = session.session.activeOrganizationId;
    if (!organizationId) return { status: 'no-active-workspace' };

    const [membership] = await controlDb
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
      .limit(1);
    if (!membership) return { status: 'not-a-member' };

    const requestId = crypto.randomUUID();
    // Melos assigns one role per member; Better Auth joins several with commas (P-30).
    if (membership.role.includes(',') || !isWorkspaceRole(membership.role)) {
      // Ids only: the session, its token and the request headers are never logged.
      const { id: memberId, role } = membership;
      const detail = { requestId, organizationId, userId, memberId, role };
      console.error('TenantContextResolver configuration error: invalid member role', detail);
      return { status: 'invalid-role' };
    }

    return {
      status: 'ok',
      context: { userId, organizationId, workspaceRole: membership.role, requestId },
    };
  },
};
