'use client';

import { type FormEvent, useState } from 'react';
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

    const created = await authClient.organization.create({
      name,
      slug: toSlug(name),
    });
    if (created.error || !created.data) {
      setPending(false);
      setError(created.error?.message ?? 'Could not create the workspace.');
      return;
    }

    const active = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    if (active.error) {
      setPending(false);
      setError(active.error.message ?? 'Could not open the workspace.');
      return;
    }
    window.location.assign('/');
  }

  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <h1>Create a workspace</h1>
      <label>
        Workspace name
        <input name="name" autoComplete="organization" required maxLength={80} />
      </label>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? 'Creating workspace...' : 'Create workspace'}
      </button>
    </form>
  );
}
