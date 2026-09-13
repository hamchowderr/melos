'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
// Exactly the four workspace roles; a member holds one (P-30). A native select, so forms submit it.
const ROLE_OPTIONS = Object.keys(roles).map((role) => (
  <NativeSelectOption key={role}>{role}</NativeSelectOption>
));

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
    <PageCard title="Members" className="max-w-2xl">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            {canRemove ? (
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map(({ id, role, user }) => (
            <TableRow key={id}>
              <TableCell>
                <div className="font-medium">{user.name}</div>
                <div className="text-muted-foreground">{user.email}</div>
              </TableCell>
              <TableCell>
                {canSetRole ? (
                  <NativeSelect
                    size="sm"
                    aria-label={`Role for ${user.email}`}
                    value={role}
                    disabled={pending}
                    onChange={({ target }) =>
                      setRole(id, target.value as WorkspaceRole, user.email)
                    }
                  >
                    {ROLE_OPTIONS}
                  </NativeSelect>
                ) : (
                  <Badge variant="secondary">{role}</Badge>
                )}
              </TableCell>
              {canRemove ? (
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${user.email}`}
                    disabled={pending}
                    onClick={() => remove(id, user.email)}
                  >
                    Remove
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {invitations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Pending invitations</h2>
          <ul className="divide-y border-y" aria-label="Pending invitations">
            {invitations.map(({ id, email, role, expires, invitedBy }) => (
              <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <strong className="font-medium text-foreground">{email}</strong> invited by{' '}
                  {invitedBy}, expires {expires}
                </span>
                <Badge variant="secondary">{role}</Badge>
                {canInvite ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Cancel invitation to ${email}`}
                    disabled={pending}
                    onClick={() => cancel(id, email)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {canInvite ? <Separator /> : null}
      {canInvite && invitationsUnavailable ? (
        <p className="text-muted-foreground">
          Invitations are unavailable until email sending is set up.
        </p>
      ) : null}
      {canInvite && !invitationsUnavailable ? (
        <form onSubmit={invite}>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input id="invite-email" name="email" type="email" autoComplete="off" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                <NativeSelect id="invite-role" name="role" defaultValue="member">
                  {ROLE_OPTIONS}
                </NativeSelect>
              </Field>
            </div>
            <Button type="submit" className="self-start" disabled={pending}>
              Send invitation
            </Button>
          </FieldGroup>
        </form>
      ) : null}
      {notice?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
      {notice && !notice.error ? (
        <output className="text-muted-foreground">{notice.text}</output>
      ) : null}
    </PageCard>
  );
}
