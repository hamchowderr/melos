import { headers } from 'next/headers';
import { notReadyStatus } from '@/app/workspace-status';
import {
  type TenantContext,
  tenantContextResolver,
  type UnavailableWorkspaceStatus,
} from '@/server/services/tenant-context';

/** The tenant a Server Action writes for, or why it cannot write. */
export type WorkspaceAction =
  | { status: 'ready'; tenant: TenantContext }
  | { status: 'unauthenticated' }
  | { status: 'no-workspace' }
  | { status: 'not-ready'; workspaceStatus: UnavailableWorkspaceStatus };

/**
 * The tenant of a Server Action request, resolved from the session and melos-control on every call
 * as pages resolve theirs (§7.1), but refusals come back to the action instead of redirecting. No
 * active workspace, not a member and an invalid role (P-30, logged by the resolver) are no-workspace;
 * a workspace without an active database is not-ready. The service the action calls checks the role.
 */
export async function resolveWorkspaceAction(): Promise<WorkspaceAction> {
  const resolved = await tenantContextResolver.resolve(await headers());
  if (resolved.status === 'ok') return { status: 'ready', tenant: resolved.context };
  if (resolved.status === 'unauthenticated') return { status: 'unauthenticated' };
  const workspaceStatus = notReadyStatus(resolved);
  return workspaceStatus ? { status: 'not-ready', workspaceStatus } : { status: 'no-workspace' };
}
