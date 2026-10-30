import { ChevronsUpDown } from 'lucide-react';
import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { WorkspaceNav, type WorkspaceSection } from '@/components/workspace/workspace-nav';

export type WorkspaceSidebarProps = {
  workspaceName: string;
  current: WorkspaceSection;
  /** The phone menu repeats the sidebar; only the visible copy carries the test id. */
  menu?: boolean;
};

/** The workspace's switcher, areas and sign-out, shared by the sidebar and the phone menu. */
export function WorkspaceSidebarContent({ workspaceName, current, menu }: WorkspaceSidebarProps) {
  return (
    <div className="flex h-full flex-col gap-3 p-2">
      <Link
        href="/workspaces"
        aria-label="Switch workspace"
        className="flex items-center gap-2 rounded-md p-1.5 hover:bg-sidebar-accent"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          M
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-xs text-muted-foreground">Melos</span>
          <span
            className="truncate text-sm font-medium"
            data-testid={menu ? undefined : 'active-workspace-name'}
          >
            {workspaceName}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      <WorkspaceNav current={current} />
      <div className="mt-auto">
        <SignOutButton variant="ghost" size="sm" />
      </div>
    </div>
  );
}
