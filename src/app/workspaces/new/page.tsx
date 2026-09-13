import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form';
import { auth } from '@/server/auth/auth';

export const dynamic = 'force-dynamic';

export default async function NewWorkspacePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <CreateWorkspaceForm />
    </main>
  );
}
