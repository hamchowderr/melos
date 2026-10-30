import { resolveWorkspacePage } from '@/app/workspace-page';
import { WorkspaceChat } from '@/components/chat/workspace-chat';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="chat" fill>
      <WorkspaceChat />
    </WorkspaceShell>
  );
}
