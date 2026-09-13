import { format } from 'node:util';
import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthEmail } from '../../src/server/auth/mailer';
import { BASE_URL, prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Person = { client: TestClient; email: string };

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let readOutbox: () => readonly AuthEmail[];
/** Everything written through the console, which Better Auth's default logger uses. */
const logs: string[] = [];

beforeAll(async () => {
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(format(...args));
    });
  }
  mock = await prepareTestEnvironment('invitations');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ readMemoryOutbox: readOutbox } = await import('../../src/server/auth/mailer'));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mock?.stop();
});

const stamp = Date.now();
const owner: Person = { client: new TestClient(), email: `owner-${stamp}@example.test` };
const invitee: Person = { client: new TestClient(), email: `invitee-${stamp}@example.test` };
let workspaceId = '';
let invitationId = '';

function post({ client }: Person, path: string, body: unknown) {
  return client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
}

function newestEmail(kind: AuthEmail['kind'], to: string): AuthEmail {
  const email = readOutbox().findLast((sent) => sent.kind === kind && sent.to === to);
  if (!email) throw new Error(`no ${kind} email to ${to}`);
  return email;
}

async function isVerified({ client }: Person) {
  return (await auth.api.getSession({ headers: client.headers() }))?.user.emailVerified;
}

async function signUpAndSignIn(person: Person) {
  const credentials = { email: person.email, password: 'integration-password-123' };
  expect((await post(person, '/sign-up/email', { ...credentials, name: 'Test' })).status).toBe(200);
  expect((await post(person, '/sign-in/email', credentials)).status).toBe(200);
  expect(await isVerified(person)).toBe(false);
}

/** Opens the emailed verification link with the recipient's cookies, as a browser would. */
async function verify(person: Person) {
  const { link } = newestEmail('verify-email', person.email);
  expect(link).toMatch(`${BASE_URL}/api/auth/verify-email?token=`);
  const opened = await person.client.call(authRoute.GET, 'GET', link.slice(BASE_URL.length));
  expect(opened.status).toBe(302);
  expect(await isVerified(person)).toBe(true);
}

describe('AUTH-002: email verification and workspace invitations', () => {
  it('sends a verification email on sign-up whose link marks the address verified', async () => {
    await signUpAndSignIn(owner);
    await verify(owner);
  });

  it('sends an invitation email whose link names the invitation page', async () => {
    const created = await post(owner, '/organization/create', {
      name: 'Invite Records',
      slug: `invite-records-${stamp}`,
    });
    workspaceId = ((await created.json()) as { id: string }).id;
    const invited = await post(owner, '/organization/invite-member', {
      email: invitee.email,
      role: 'admin',
      organizationId: workspaceId,
    });
    expect(invited.status).toBe(200);
    invitationId = ((await invited.json()) as { id: string }).id;

    const email = newestEmail('invitation', invitee.email);
    expect(email.link).toBe(`${BASE_URL}/invitations/${invitationId}`);
    expect(email.text).toContain('Invite Records as admin');
  });

  it('refuses an unverified invitee', async () => {
    await signUpAndSignIn(invitee);
    const accepted = await post(invitee, '/organization/accept-invitation', { invitationId });
    expect(accepted.status).toBe(403);
    expect(((await accepted.json()) as { code: string }).code).toBe(
      'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
    );
    // Still not a member: the workspace cannot be made active.
    const active = await post(invitee, '/organization/set-active', { organizationId: workspaceId });
    expect(active.status).toBe(403);
  });

  it('makes a verified invitee a member with the invited role who can open the workspace', async () => {
    await verify(invitee);
    // What the invitation page reads and shows.
    const invitation = await auth.api.getInvitation({
      headers: invitee.client.headers(),
      query: { id: invitationId },
    });
    expect(invitation).toMatchObject({ organizationName: 'Invite Records', role: 'admin' });

    const accepted = await post(invitee, '/organization/accept-invitation', { invitationId });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { member: { role: string } }).member.role).toBe('admin');

    const active = await post(invitee, '/organization/set-active', { organizationId: workspaceId });
    expect(active.status).toBe(200);
    const headers = invitee.client.headers();
    expect((await auth.api.getActiveMember({ headers }))?.role).toBe('admin');
    expect((await auth.api.getSession({ headers }))?.session.activeOrganizationId).toBe(
      workspaceId,
    );
  });

  it('writes no email body or link to the logs', () => {
    console.warn('log capture check');
    expect(logs).toContain('log capture check');

    const logged = logs.join('\n');
    const emails = readOutbox();
    expect(emails.length).toBeGreaterThanOrEqual(3);
    for (const email of emails) {
      const url = new URL(email.link);
      for (const secret of [
        email.text,
        email.link,
        url.searchParams.get('token') ?? url.pathname,
      ]) {
        expect(logged).not.toContain(secret);
      }
    }
  });
});
