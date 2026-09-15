import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { PageCard } from '@/components/page-card';
import { buttonVariants } from '@/components/ui/button';

type Status = 'provisioning' | 'migrating' | 'failed' | 'suspended' | 'deleting';

const COPY: Record<Status, { title: string; message: string }> = {
  provisioning: {
    title: 'Your workspace is still being set up',
    message:
      'This workspace opens once its database is ready. If it stays unavailable, try again later, or contact the workspace owner.',
  },
  migrating: {
    title: 'Your workspace is being updated',
    message:
      'This workspace opens again once the update finishes. If it stays unavailable, try again later, or contact the workspace owner.',
  },
  failed: {
    title: 'Your workspace is not available right now',
    message:
      'Its database ran into a problem during setup or an update. The workspace and its members are kept. Try again later, or contact the workspace owner.',
  },
  suspended: {
    title: 'This workspace is suspended',
    message: 'The workspace cannot be opened while it is suspended.',
  },
  deleting: {
    title: 'This workspace is being deleted',
    message: 'The workspace can no longer be opened.',
  },
};

/** Shown instead of a workspace page while the active workspace has no active database (§7.1 step 2.3). */
export function WorkspaceNotReady({ status }: { status: Status }) {
  const { title, message } = COPY[status];
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <PageCard title={title}>
        <p className="text-muted-foreground" data-testid="workspace-not-ready" data-status={status}>
          {message}
        </p>
        {/* A member stuck on this workspace can open another one or sign out. */}
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/workspaces" className={buttonVariants({ variant: 'outline' })}>
            Switch workspace
          </Link>
          <SignOutButton variant="ghost" />
        </div>
      </PageCard>
    </main>
  );
}
