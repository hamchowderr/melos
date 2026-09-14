import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { WorkspaceNav, type WorkspaceSection } from '@/components/workspace/workspace-nav';

type Props = { workspaceName: string; current: WorkspaceSection };

export function WorkspaceHeader({ workspaceName, current }: Props) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
      <span className="font-semibold">Melos</span>
      <Separator orientation="vertical" />
      <span
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
        data-testid="active-workspace-name"
      >
        {workspaceName}
      </span>
      <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto">
        <WorkspaceNav current={current} />
        <Link href="/workspaces" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          Switch workspace
        </Link>
        <SignOutButton variant="ghost" size="sm" />
      </div>
    </header>
  );
}
