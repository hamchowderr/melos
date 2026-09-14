import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { WorkspaceChat } from '@/components/chat/workspace-chat';
import { buttonVariants } from '@/components/ui/button';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { auth } from '@/server/auth/auth';
import { tenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const requestHeaders = await headers();
  const tenant = await tenantContextResolver.resolve(requestHeaders);
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  // A member of a workspace without an active database is never sent to create another one.
  if (tenant.status === 'workspace-unavailable') {
    return <WorkspaceNotReady status={tenant.workspaceStatus} />;
  }
  if (tenant.status === 'workspace-not-provisioned') return <WorkspaceNotReady status="failed" />;
  if (tenant.status !== 'ok') redirect('/workspaces/new');

  // Read server-side for the session's active organization; Better Auth checks membership.
  const workspace = await auth.api
    .getOrganization({
      headers: requestHeaders,
      query: { organizationId: tenant.context.organizationId },
    })
    .catch(() => null);
  if (!workspace) redirect('/workspaces/new');

  return (
    <main className="flex h-dvh flex-col">
      <WorkspaceHeader workspaceName={workspace.name}>
        <Link href="/settings" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          Settings
        </Link>
      </WorkspaceHeader>
      <WorkspaceChat />
    </main>
  );
}
