'use client';

import { useState } from 'react';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

type Invitation = { id: string; organizationName: string; role: string; inviterEmail: string };

export function InvitationResponse({ invitation }: { invitation: Invitation }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function respond(accept: boolean) {
    setPending(true);
    setError(null);
    const body = { invitationId: invitation.id };
    const result = accept
      ? await authClient.organization.acceptInvitation(body)
      : await authClient.organization.rejectInvitation(body);
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? 'Could not answer the invitation.');
      return;
    }
    // Accepting makes the workspace active. Full navigation so the server reads the session.
    window.location.assign('/');
  }

  return (
    <PageCard title="Workspace invitation">
      <p className="text-muted-foreground">
        {invitation.inviterEmail} invited you to{' '}
        <strong className="font-medium text-foreground" data-testid="invitation-workspace-name">
          {invitation.organizationName}
        </strong>{' '}
        as{' '}
        <Badge variant="secondary" data-testid="invitation-role">
          {invitation.role}
        </Badge>
        .
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button type="button" disabled={pending} onClick={() => respond(true)}>
          Accept invitation
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => respond(false)}>
          Decline
        </Button>
      </div>
    </PageCard>
  );
}
