'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { authClient } from '@/lib/auth/client';

type Workspace = { organizationId: string; name: string; role: string };

/** Lists the user's workspaces; Better Auth refuses to set one active that the user is not in. */
export function WorkspacePicker({ workspaces }: { workspaces: Workspace[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function choose(organizationId: string) {
    setPendingId(organizationId);
    setError(null);
    // The auth client throws on a network error instead of returning one.
    const active = await authClient.organization.setActive({ organizationId }).catch(() => null);
    if (!active || active.error) {
      setPendingId(null);
      setError(active?.error?.message ?? 'Could not open the workspace.');
      return;
    }
    // Full navigation so the server reads the session.
    window.location.assign('/');
  }

  return (
    <PageCard title="Choose a workspace">
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from a ul styled without bullets. */}
      <ul role="list" className="flex flex-col gap-2" aria-label="Your workspaces">
        {workspaces.map(({ organizationId, name, role }) => (
          <li key={organizationId}>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full justify-between"
              disabled={pendingId !== null}
              onClick={() => choose(organizationId)}
            >
              <span className="min-w-0 truncate">{name}</span>
              {pendingId === organizationId ? (
                <span className="text-muted-foreground">Opening...</span>
              ) : (
                <Badge variant="secondary">{role}</Badge>
              )}
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <FieldDescription className="text-center">
        Or <Link href="/workspaces/new">create a workspace</Link>.
      </FieldDescription>
      <div className="flex flex-wrap items-center gap-2">
        <SignOutButton variant="ghost" />
      </div>
    </PageCard>
  );
}
