import type { ReactNode } from 'react';
import { WorkspaceMenu } from '@/components/workspace/workspace-menu';
import type { WorkspaceSection } from '@/components/workspace/workspace-nav';
import { WorkspaceSidebarContent } from '@/components/workspace/workspace-sidebar';
import { cn } from '@/lib/utils';

type Props = {
  workspaceName: string;
  current: WorkspaceSection;
  /** Fill the viewport without page scroll (chat), instead of growing with the content. */
  fill?: boolean;
  children: ReactNode;
};

/** A workspace page: a left sidebar from md up, a top bar with a menu drawer below it. */
export function WorkspaceShell({ workspaceName, current, fill, children }: Props) {
  return (
    <div className={cn('flex', fill ? 'h-dvh' : 'min-h-dvh')}>
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block">
        <WorkspaceSidebarContent workspaceName={workspaceName} current={current} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:hidden">
          <WorkspaceMenu title={workspaceName}>
            <WorkspaceSidebarContent workspaceName={workspaceName} current={current} menu />
          </WorkspaceMenu>
          <span className="truncate text-sm font-medium">{workspaceName}</span>
        </div>
        <main className={cn('flex min-w-0 flex-1 flex-col', fill && 'min-h-0')}>{children}</main>
      </div>
    </div>
  );
}
