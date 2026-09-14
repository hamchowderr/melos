'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { PageCard } from '@/components/page-card';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth/client';

export function SignInForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    // The auth client throws on a network error instead of returning one.
    const result = await authClient.signIn
      .email({ email: String(form.get('email')), password: String(form.get('password')) })
      .catch(() => null);
    if (!result || result.error) {
      setPending(false);
      setError(result?.error?.message ?? 'Could not sign in.');
      return;
    }
    // Full navigation so the server reads the new session cookie.
    window.location.assign('/');
  }

  return (
    <PageCard title="Sign in">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <FieldError>{error}</FieldError>
          <Field>
            <Button type="submit" disabled={pending}>
              {pending ? 'Signing in...' : 'Sign in'}
            </Button>
            <FieldDescription className="text-center">
              New to Melos? <Link href="/sign-up">Create an account</Link>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
    </PageCard>
  );
}
