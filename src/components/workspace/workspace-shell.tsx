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

/**
 * A workspace page: from md up, the sidebar on the tinted background and the page in a rounded
 * panel inset beside it; below md, a top bar with a menu drawer.
 */
export function WorkspaceShell({ workspaceName, current, fill, children }: Props) {
  return (
    <div className={cn('flex bg-sidebar', fill ? 'h-dvh' : 'min-h-dvh')}>
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 text-sidebar-foreground md:block">
        <WorkspaceSidebarContent workspaceName={workspaceName} current={current} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex h-12 shrink-0 items-center gap-2 px-2 md:hidden">
          <WorkspaceMenu title={workspaceName}>
            <WorkspaceSidebarContent workspaceName={workspaceName} current={current} menu />
          </WorkspaceMenu>
          <span className="truncate text-sm font-medium">{workspaceName}</span>
        </div>
        <main
          className={cn(
            'flex min-w-0 flex-1 flex-col bg-background md:rounded-xl md:shadow-sm md:ring-1 md:ring-foreground/5',
            fill && 'min-h-0 overflow-hidden',
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
