import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MembersPanel } from '@/components/workspace/members-panel';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import type { WorkspacePermissions } from '@/lib/auth/permissions';
import { auth } from '@/server/auth/auth';
import { requirePermission } from '@/server/services/permissions';
import { tenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const requestHeaders = await headers();
  const tenant = await tenantContextResolver.resolve(requestHeaders);
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  if (tenant.status !== 'ok') redirect('/workspaces/new');

  // Membership lives only in Better Auth (docs/CONTRACT.md §6.1), which checks the caller.
  const query = { organizationId: tenant.context.organizationId };
  const [workspace, list] = await Promise.all([
    auth.api.getOrganization({ headers: requestHeaders, query }).catch(() => null),
    auth.api.listMembers({ headers: requestHeaders, query }).catch(() => null),
  ]);
  if (!workspace || !list) redirect('/workspaces/new');

  // Decides which controls to show, from the role resolved for this request (§7.1).
  const can = (permissions: WorkspacePermissions) =>
    requirePermission(tenant.context, permissions).ok;

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.name}>
        <Link href="/">Chat</Link>
      </WorkspaceHeader>
      <div className="settings-body">
        <MembersPanel
          members={list.members}
          canInvite={can({ invitation: ['create'] })}
          canSetRole={can({ member: ['update'] })}
          canRemove={can({ member: ['delete'] })}
        />
      </div>
    </main>
  );
}
