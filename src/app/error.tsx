'use client';

import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { PageCard } from '@/components/page-card';
import { Button, buttonVariants } from '@/components/ui/button';

type Props = { error: Error & { digest?: string }; retry: () => void };

/**
 * Shown when a page throws, such as a workspace database read failing with
 * WorkspaceConnectionError. The error message is never shown: it may hold a URL or a token (§7.2).
 */
export default function WorkspaceError({ retry }: Props) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <PageCard title="This page could not load">
        <p className="text-muted-foreground" data-testid="workspace-error">
          The workspace could not be read just now. Nothing was changed. Try again, or open another
          workspace.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* retry re-fetches the page from the server, so a recovered database renders it. */}
          <Button type="button" onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/workspaces" className={buttonVariants({ variant: 'outline' })}>
            Switch workspace
          </Link>
          <SignOutButton variant="ghost" />
        </div>
      </PageCard>
    </main>
  );
}
