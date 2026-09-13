import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { InvitationResponse } from '@/components/workspace/invitation-response';
import { auth } from '@/server/auth/auth';

export const dynamic = 'force-dynamic';

export default async function InvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect('/sign-in');

  // Better Auth only shows an invitation to its verified recipient (GHSA-fmh4-wcc4-5jm3).
  const invitation = session.user.emailVerified
    ? await auth.api.getInvitation({ headers: requestHeaders, query: { id } }).catch(() => null)
    : null;

  return (
    <main className="auth-page">
      {invitation ? (
        <InvitationResponse invitation={invitation} />
      ) : (
        <section className="auth-card">
          <h1>Workspace invitation</h1>
          <p className="auth-switch">
            {session.user.emailVerified
              ? 'This invitation has expired, was already answered, or was sent to another address.'
              : 'Verify your email address with the link we emailed you, then open this invitation again.'}{' '}
            <Link href="/">Back to Melos</Link>
          </p>
        </section>
      )}
    </main>
  );
}
