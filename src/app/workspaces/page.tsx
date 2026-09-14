import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { WorkspacePicker } from '@/components/workspace/workspace-picker';
import { auth } from '@/server/auth/auth';
import { listMemberships } from '@/server/services/memberships';

export const dynamic = 'force-dynamic';

export default async function WorkspacesPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const workspaces = await listMemberships(session.user.id);
  if (workspaces.length === 0) redirect('/workspaces/new');

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <WorkspacePicker workspaces={workspaces} />
    </main>
  );
}
