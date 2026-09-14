import { and, eq } from 'drizzle-orm';
import { isWorkspaceRole, type WorkspaceRole } from '../../lib/auth/permissions';
import { auth } from '../auth/auth';
import { controlDb } from '../db/client';
import { member } from '../db/schema/auth';
import { type WORKSPACE_STATUSES, workspaceRegistry } from '../db/schema/control';

/**
 * Who is calling, in which workspace, with which role (docs/CONTRACT.md §7.1 step 2.4). Ids only:
 * services open the workspace database with getWorkspaceDatabase(workspaceId) (§7.2).
 */
export type TenantContext = {
  userId: string;
  organizationId: string;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
  requestId: string;
};

/** A registry status that serves no request: provisioning, migrating, failed, suspended, deleting. */
export type UnavailableWorkspaceStatus = Exclude<(typeof WORKSPACE_STATUSES)[number], 'active'>;

export type TenantResolution =
  | { status: 'ok'; context: TenantContext }
  | {
      status:
        | 'unauthenticated'
        | 'no-active-workspace'
        | 'not-a-member'
        | 'invalid-role'
        | 'workspace-not-provisioned';
    }
  | { status: 'workspace-unavailable'; workspaceStatus: UnavailableWorkspaceStatus };

/** Derives who is calling and which workspace they act in. Never trusts client input. */
export interface TenantContextResolver {
  resolve(headers: Headers): Promise<TenantResolution>;
}

/**
 * docs/CONTRACT.md §7.1 step 1 and steps 2.1 to 2.4. The session, the member row and the
 * workspace_registry row are read on every request and never cached, so a removed member, a
 * changed role or a workspace leaving `active` applies to the next request. A null active
 * workspace is never defaulted to another workspace.
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

    // Only the id and status: db_token_ciphertext and status_detail never leave the control plane.
    const [workspace] = await controlDb
      .select({ id: workspaceRegistry.id, status: workspaceRegistry.status })
      .from(workspaceRegistry)
      .where(eq(workspaceRegistry.organizationId, organizationId))
      .limit(1);
    if (!workspace) return { status: 'workspace-not-provisioned' };
    if (workspace.status !== 'active') {
      return { status: 'workspace-unavailable', workspaceStatus: workspace.status };
    }

    const workspaceRole = membership.role;
    return {
      status: 'ok',
      context: { userId, organizationId, workspaceId: workspace.id, workspaceRole, requestId },
    };
  },
};
