import { PageCard } from '@/components/page-card';

type Status = 'provisioning' | 'migrating' | 'failed' | 'suspended' | 'deleting';

const COPY: Record<Status, { title: string; message: string }> = {
  provisioning: {
    title: 'Your workspace is still being set up',
    message: 'Chat opens once its database is ready. Reload this page in a moment.',
  },
  migrating: {
    title: 'Your workspace is being updated',
    message: 'Chat opens again once the update finishes. Reload this page in a moment.',
  },
  failed: {
    title: 'Your workspace could not be set up',
    message:
      'Melos could not set up its database. The workspace and its members are kept, so you do not need to create another one.',
  },
  suspended: {
    title: 'This workspace is suspended',
    message: 'Chat is unavailable while the workspace is suspended.',
  },
  deleting: {
    title: 'This workspace is being deleted',
    message: 'Chat is no longer available for this workspace.',
  },
};

/** Shown instead of the chat while the active workspace has no active database (§7.1 step 2.3). */
export function WorkspaceNotReady({ status }: { status: Status }) {
  const { title, message } = COPY[status];
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <PageCard title={title}>
        <p className="text-muted-foreground" data-testid="workspace-not-ready" data-status={status}>
          {message}
        </p>
      </PageCard>
    </main>
  );
}
