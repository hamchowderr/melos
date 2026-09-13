'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { roles, type WorkspaceRole } from '@/lib/auth/permissions';

type MemberRow = { id: string; role: string; user: { name: string; email: string } };
type Props = { members: MemberRow[]; canInvite: boolean; canSetRole: boolean; canRemove: boolean };

const org = authClient.organization;
// Exactly the four workspace roles; a member holds one (P-30).
const ROLE_OPTIONS = Object.keys(roles).map((role) => <option key={role}>{role}</option>);

/** Controls a role may not use are hidden for clarity only; Better Auth enforces (AUTH-004). */
export function MembersPanel({ members, canInvite, canSetRole, canRemove }: Props) {
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
      {canInvite ? (
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
