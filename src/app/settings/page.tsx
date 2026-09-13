import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { MembersPanel } from '@/components/workspace/members-panel';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import type { WorkspacePermissions } from '@/lib/auth/permissions';
import { auth } from '@/server/auth/auth';
import { getServerEnv } from '@/server/env';
import { requirePermission } from '@/server/services/permissions';
import { tenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

// Formatted on the server in one time zone, so the client renders the same text.
const expiry = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export default async function SettingsPage() {
  const requestHeaders = await headers();
  const tenant = await tenantContextResolver.resolve(requestHeaders);
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  // The home page explains a workspace without an active database.
  if (tenant.status === 'workspace-unavailable' || tenant.status === 'workspace-not-provisioned') {
    redirect('/');
  }
  if (tenant.status !== 'ok') redirect('/workspaces/new');

  // Membership lives only in Better Auth (docs/CONTRACT.md §6.1), which checks the caller.
  const query = { organizationId: tenant.context.organizationId };
  const [workspace, list, invitations] = await Promise.all([
    auth.api.getOrganization({ headers: requestHeaders, query }).catch(() => null),
    auth.api.listMembers({ headers: requestHeaders, query }).catch(() => null),
    auth.api.listInvitations({ headers: requestHeaders, query }).catch(() => null),
  ]);
  if (!workspace || !list || !invitations) redirect('/workspaces/new');

  // Decides which controls to show, from the role resolved for this request (§7.1).
  const can = (permissions: WorkspacePermissions) =>
    requirePermission(tenant.context, permissions).ok;

  // Better Auth lists every invitation it wrote; only a pending, unexpired one can be accepted.
  const now = new Date();
  const emails = new Map(list.members.map(({ userId, user }) => [userId, user.email]));
  const pending = invitations
    .filter(({ status, expiresAt }) => status === 'pending' && new Date(expiresAt) > now)
    .map(({ id, email, role, expiresAt, inviterId }) => ({
      id,
      email,
      role,
      expires: `${expiry.format(new Date(expiresAt))} UTC`,
      invitedBy: emails.get(inviterId) ?? 'a former member',
    }));

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.name}>
        <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          Chat
        </Link>
      </WorkspaceHeader>
      <div className="flex justify-center px-4 py-6">
        <MembersPanel
          members={list.members}
          invitations={pending}
          // Better Auth checks invitation:cancel, which the same roles hold.
          canInvite={can({ invitation: ['create'] })}
          invitationsUnavailable={getServerEnv().authMailer === 'disabled'}
          canSetRole={can({ member: ['update'] })}
          canRemove={can({ member: ['delete'] })}
        />
      </div>
    </main>
  );
}
