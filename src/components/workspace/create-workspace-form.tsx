'use client';

import { type FormEvent, useState } from 'react';
import { PageCard } from '@/components/page-card';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth/client';

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
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    setPending(true);
    setError(null);

    // The auth client throws on a network error instead of returning one.
    const created = await authClient.organization
      .create({ name, slug: toSlug(name) })
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
          <FieldError>{error}</FieldError>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating workspace...' : 'Create workspace'}
          </Button>
        </FieldGroup>
      </form>
    </PageCard>
  );
}
