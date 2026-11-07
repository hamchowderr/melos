'use client';

import { type FormEvent, useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { WorkspaceTypePicker } from '@/components/onboarding/workspace-type-picker';
import { PageCard } from '@/components/page-card';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth/client';
import { isWorkspaceType } from '@/lib/workspace-type';

function toSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace';
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function CreateWorkspaceForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name')).trim();
    const workspaceType = form.get('workspaceType');
    // The radios are required, so the browser asks first; this covers a form that skipped it.
    if (!isWorkspaceType(workspaceType)) {
      setError('Choose which describes you.');
      return;
    }
    setPending(true);
    setError(null);

    // The auth client throws on a network error instead of returning one.
    const created = await authClient.organization
      .create({ name, slug: toSlug(name), metadata: { workspaceType } })
      .catch(() => null);
    if (!created || created.error || !created.data) {
      setPending(false);
      setError(created?.error?.message ?? 'Could not create the workspace.');
      return;
    }

    const active = await authClient.organization
      .setActive({ organizationId: created.data.id })
      .catch(() => null);
    if (!active || active.error) {
      setPending(false);
      setError(active?.error?.message ?? 'Could not open the workspace.');
      return;
    }
    window.location.assign('/');
  }

  return (
    <PageCard title="Create a workspace">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Workspace name</FieldLabel>
            <Input id="name" name="name" autoComplete="organization" required maxLength={80} />
          </Field>
          <WorkspaceTypePicker required />
          <FieldError>{error}</FieldError>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating workspace...' : 'Create workspace'}
          </Button>
        </FieldGroup>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <SignOutButton variant="ghost" />
      </div>
    </PageCard>
  );
}
