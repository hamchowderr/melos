'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth/client';

export function SignInForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? 'Could not sign in.');
      return;
    }
    // Full navigation so the server reads the new session cookie.
    window.location.assign('/');
  }

  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? 'Signing in...' : 'Sign in'}
      </button>
      <p className="auth-switch">
        New to Melos? <Link href="/sign-up">Create an account</Link>
      </p>
    </form>
  );
}
