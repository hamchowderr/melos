import { resolveWorkspacePage } from '@/app/workspace-page';
import { WorkspaceChat } from '@/components/chat/workspace-chat';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }

  return (
    <main className="flex h-dvh flex-col">
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="chat" />
      <WorkspaceChat />
    </main>
  );
}
