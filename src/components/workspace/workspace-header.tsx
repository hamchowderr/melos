export function WorkspaceHeader({ workspaceName }: { workspaceName: string }) {
  return (
    <header className="chat-header">
      <span>Melos</span>
      <span className="chat-header-workspace" data-testid="active-workspace-name">
        {workspaceName}
      </span>
    </header>
  );
}
