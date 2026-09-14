'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

type Workspace = { organizationId: string; name: string; role: string };

/** Lists the user's workspaces; Better Auth refuses to set one active that the user is not in. */
export function WorkspacePicker({ workspaces }: { workspaces: Workspace[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function choose(organizationId: string) {
    setPending(true);
    setError(null);
    const active = await authClient.organization.setActive({ organizationId });
    if (active.error) {
      setPending(false);
      setError(active.error.message ?? 'Could not open the workspace.');
      return;
    }
    // Full navigation so the server reads the session.
    window.location.assign('/');
  }

  return (
    <PageCard title="Choose a workspace">
      <ul className="flex flex-col gap-2" aria-label="Your workspaces">
        {workspaces.map(({ organizationId, name, role }) => (
          <li key={organizationId}>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full justify-between"
              disabled={pending}
              onClick={() => choose(organizationId)}
            >
              <span className="min-w-0 truncate">{name}</span>
              <Badge variant="secondary">{role}</Badge>
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-muted-foreground">
        Or{' '}
        <Link href="/workspaces/new" className="text-foreground underline underline-offset-4">
          create a workspace
        </Link>
        .
      </p>
    </PageCard>
  );
}
