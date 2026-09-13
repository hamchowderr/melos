'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { roles, type WorkspaceRole } from '@/lib/auth/permissions';

type MemberRow = { id: string; role: string; user: { name: string; email: string } };
/** A pending, unexpired invitation; the server formats `expires`, so hydration matches. */
type InvitationRow = {
  id: string;
  email: string;
  role: string;
  expires: string;
  invitedBy: string;
};
type Props = {
  members: MemberRow[];
  invitations: InvitationRow[];
  /** Shows the invite form and each invitation's Cancel button. */
  canInvite: boolean;
  /** MELOS_AUTH_MAILER=disabled: the server refuses every invitation (INVITATIONS_UNAVAILABLE). */
  invitationsUnavailable: boolean;
  canSetRole: boolean;
  canRemove: boolean;
};

const org = authClient.organization;
// Exactly the four workspace roles; a member holds one (P-30).
const ROLE_OPTIONS = Object.keys(roles).map((role) => <option key={role}>{role}</option>);

/** Controls a role may not use are hidden for clarity only; Better Auth enforces (AUTH-004). */
export function MembersPanel({
  members,
  invitations,
  canInvite,
  invitationsUnavailable,
  canSetRole,
  canRemove,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  async function run(action: () => Promise<{ error: { message?: string } | null }>, done: string) {
    setPending(true);
    setNotice(null);
    const { error } = await action();
    setPending(false);
    const text = error ? (error.message ?? 'Could not update the members.') : done;
    setNotice({ error: Boolean(error), text });
    router.refresh();
    return !error;
  }

  const setRole = (memberId: string, role: WorkspaceRole, email: string) =>
    run(() => org.updateMemberRole({ memberId, role }), `${email} is now ${role}.`);
  const remove = (memberIdOrEmail: string, email: string) =>
    run(() => org.removeMember({ memberIdOrEmail }), `Removed ${email}.`);
  const cancel = (invitationId: string, email: string) =>
    run(() => org.cancelInvitation({ invitationId }), `Canceled the invitation to ${email}.`);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email')).trim();
    const role = String(data.get('role')) as WorkspaceRole;
    const sent = `Invitation sent to ${email}.`;
    if (await run(() => org.inviteMember({ email, role }), sent)) form.reset();
  }

  return (
    <section className="auth-card members-card">
      <h1>Members</h1>
      <ul className="member-list">
        {members.map(({ id, role, user }) => (
          <li key={id}>
            <span className="member-name">
              <strong>{user.name}</strong> {user.email}
            </span>
            {canSetRole ? (
              <select
                aria-label={`Role for ${user.email}`}
                value={role}
                disabled={pending}
                onChange={({ target }) => setRole(id, target.value as WorkspaceRole, user.email)}
              >
                {ROLE_OPTIONS}
              </select>
            ) : (
              <span>{role}</span>
            )}
            {canRemove ? (
              <button
                type="button"
                className="secondary"
                aria-label={`Remove ${user.email}`}
                disabled={pending}
                onClick={() => remove(id, user.email)}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {invitations.length > 0 ? (
        <>
          <h2>Pending invitations</h2>
          <ul className="member-list" aria-label="Pending invitations">
            {invitations.map(({ id, email, role, expires, invitedBy }) => (
              <li key={id}>
                <span className="member-name">
                  <strong>{email}</strong> invited by {invitedBy}, expires {expires}
                </span>
                <span>{role}</span>
                {canInvite ? (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Cancel invitation to ${email}`}
                    disabled={pending}
                    onClick={() => cancel(id, email)}
                  >
                    Cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canInvite && invitationsUnavailable ? (
        <p className="auth-switch">Invitations are unavailable until email sending is set up.</p>
      ) : null}
      {canInvite && !invitationsUnavailable ? (
        <form className="member-invite" onSubmit={invite}>
          <label>
            Email
            <input name="email" type="email" autoComplete="off" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="member">
              {ROLE_OPTIONS}
            </select>
          </label>
          <button type="submit" disabled={pending}>
            Send invitation
          </button>
        </form>
      ) : null}
      {notice?.error ? (
        <p role="alert" className="form-error">
          {notice.text}
        </p>
      ) : null}
      {notice && !notice.error ? <output className="auth-switch">{notice.text}</output> : null}
    </section>
  );
}
