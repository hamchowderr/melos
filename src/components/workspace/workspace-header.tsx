import type { ReactNode } from 'react';

type Props = { workspaceName: string; children?: ReactNode };

export function WorkspaceHeader({ workspaceName, children }: Props) {
  return (
    <header className="chat-header">
      <span>Melos</span>
      <span className="chat-header-workspace" data-testid="active-workspace-name">
        {workspaceName}
      </span>
      {children}
    </header>
  );
}
