'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

type Props = Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>;

/** Ends the session through Better Auth, then opens the sign-in page. */
export function SignOutButton(props: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    setError(null);
    // The auth client throws on a network error instead of returning one.
    const result = await authClient.signOut().catch(() => null);
    if (!result || result.error) {
      setPending(false);
      setError(result?.error?.message ?? 'Could not sign out.');
      return;
    }
    // Full navigation so the server reads the cleared session cookie.
    window.location.assign('/sign-in');
  }

  return (
    <>
      <Button type="button" disabled={pending} onClick={signOut} {...props}>
        {pending ? 'Signing out...' : 'Sign out'}
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </>
  );
}
