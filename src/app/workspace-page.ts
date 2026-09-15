import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { notReadyStatus } from '@/app/workspace-status';
import { auth } from '@/server/auth/auth';
import {
  type TenantContext,
  tenantContextResolver,
  type UnavailableWorkspaceStatus,
} from '@/server/services/tenant-context';

export type WorkspacePage =
  | { status: 'ready'; tenant: TenantContext; workspaceName: string }
  | { status: 'not-ready'; workspaceStatus: UnavailableWorkspaceStatus };

/**
 * The active workspace of a page request (§7.1), resolved once per request. A workspace without an
 * active database is not-ready, which the page explains; no active workspace, not a member and an
 * invalid role (P-30, logged by the resolver) go to /workspaces.
 */
export const resolveWorkspacePage = cache(async (): Promise<WorkspacePage> => {
  const requestHeaders = await headers();
  const tenant = await tenantContextResolver.resolve(requestHeaders);
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  const workspaceStatus = notReadyStatus(tenant);
  if (workspaceStatus) return { status: 'not-ready', workspaceStatus };
  if (tenant.status !== 'ok') redirect('/workspaces');

  // Read server-side for the session's active organization; Better Auth checks membership.
  const query = { organizationId: tenant.context.organizationId };
  const workspace = await auth.api
    .getOrganization({ headers: requestHeaders, query })
    .catch(() => null);
  if (!workspace) redirect('/workspaces/new');
  return { status: 'ready', tenant: tenant.context, workspaceName: workspace.name };
});
