import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { WorkspaceChat } from '@/components/chat/workspace-chat';
import { sessionTenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const tenant = await sessionTenantContextResolver.resolve(await headers());
  if (tenant.status === 'unauthenticated') redirect('/sign-in');
  if (tenant.status === 'no-active-workspace') redirect('/workspaces/new');

  return (
    <main className="chat-page">
      <header className="chat-header">Melos</header>
      <WorkspaceChat />
    </main>
  );
}
