import type { ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';

type Props = { workspaceName: string; children?: ReactNode };

export function WorkspaceHeader({ workspaceName, children }: Props) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
      <span className="font-semibold">Melos</span>
      <Separator orientation="vertical" />
      <span
        className="min-w-0 truncate text-sm text-muted-foreground"
        data-testid="active-workspace-name"
      >
        {workspaceName}
      </span>
      <nav className="ml-auto">{children}</nav>
    </header>
  );
}
