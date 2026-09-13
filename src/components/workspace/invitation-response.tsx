'use client';

import { useState } from 'react';
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
    <section className="auth-card">
      <h1>Workspace invitation</h1>
      <p className="auth-switch">
        {invitation.inviterEmail} invited you to{' '}
        <strong data-testid="invitation-workspace-name">{invitation.organizationName}</strong> as{' '}
        <strong data-testid="invitation-role">{invitation.role}</strong>.
      </p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <button type="button" disabled={pending} onClick={() => respond(true)}>
        Accept invitation
      </button>
      <button type="button" className="secondary" disabled={pending} onClick={() => respond(false)}>
        Decline
      </button>
    </section>
  );
}
