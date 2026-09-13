import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { WorkspaceChat } from '@/components/chat/workspace-chat';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { auth } from '@/server/auth/auth';
import { sessionTenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const requestHeaders = await headers();
  const tenant = await sessionTenantContextResolver.resolve(requestHeaders);
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  if (tenant.status === 'no-active-workspace') redirect('/workspaces/new');

  // Read server-side for the session's active organization; Better Auth checks membership.
  const workspace = await auth.api
    .getOrganization({
      headers: requestHeaders,
      query: { organizationId: tenant.context.activeOrganizationId },
    })
    .catch(() => null);
  if (!workspace) redirect('/workspaces/new');

  return (
    <main className="chat-page">
      <WorkspaceHeader workspaceName={workspace.name} />
      <WorkspaceChat />
    </main>
  );
}
