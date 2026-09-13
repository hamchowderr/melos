import { existsSync, readdirSync } from 'node:fs';
import { format } from 'node:util';
import type { LLMock } from '@copilotkit/aimock';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { invitation, user } from '../../src/server/db/schema/auth';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

const stamp = Date.now();
const listed = `listed-${stamp}@example.com`;
const unlisted = `unlisted-${stamp}@example.com`;
const newcomer = `newcomer-${stamp}@example.com`;
const password = 'integration-password-123';
const OUTBOX = '.data/auth-outbox';
const outboxFiles = () => (existsSync(OUTBOX) ? readdirSync(OUTBOX) : []);

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let outboxBefore: string[] = [];
/** Everything written through the console, which Better Auth's default logger uses. */
const logs: string[] = [];

/** The env and the auth instance are read once per module load; this reloads both. */
async function loadAuthRoute() {
  authRoute = await import('../../src/app/api/auth/[...all]/route');
}

async function usersWithEmail(email: string) {
  const { controlDb } = await import('../../src/server/db/client');
  return controlDb.select().from(user).where(eq(user.email, email));
}

async function invitationsIn(organizationId: string) {
  const { controlDb } = await import('../../src/server/db/client');
  return controlDb.select().from(invitation).where(eq(invitation.organizationId, organizationId));
}

const signUp = (email: string) =>
  new TestClient().call(authRoute.POST, 'POST', '/api/auth/sign-up/email', {
    email,
    password,
    name: 'Test',
  });

beforeAll(async () => {
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(format(...args));
    });
  }
  vi.stubEnv('MELOS_AUTH_MAILER', 'disabled');
  vi.stubEnv('MELOS_SIGNUP_ALLOWED_EMAILS', ` Other@Example.com, ,LISTED-${stamp}@example.COM `);
  outboxBefore = outboxFiles();
  mock = await prepareTestEnvironment('sign-up-allowlist');
  await loadAuthRoute();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await mock?.stop();
});

describe('Sign-up allowlist and the disabled auth mailer', () => {
  const owner = new TestClient();

  it('lets a listed address sign up, matching case-insensitively', async () => {
    expect((await signUp(`Listed-${stamp}@EXAMPLE.com`)).status).toBe(200);
    expect(await usersWithEmail(listed)).toHaveLength(1);
  });

  it('refuses an unlisted address with a 422 and creates no user', async () => {
    const refused = await signUp(unlisted);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      code: 'SIGN_UP_NOT_ALLOWED',
      message: 'Sign-up is invite-only for now.',
    });
    expect(await usersWithEmail(unlisted)).toEqual([]);
  });

  it('refuses invite-member while the mailer is disabled and writes no invitation', async () => {
    const signIn = await owner.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', {
      email: listed,
      password,
    });
    expect(signIn.status).toBe(200);
    const created = await owner.call(authRoute.POST, 'POST', '/api/auth/organization/create', {
      name: 'Allowlist Records',
      slug: `allowlist-records-${stamp}`,
    });
    const organizationId = ((await created.json()) as { id: string }).id;

    const invited = await owner.call(
      authRoute.POST,
      'POST',
      '/api/auth/organization/invite-member',
      {
        email: `invitee-${stamp}@example.com`,
        role: 'member',
        organizationId,
      },
    );
    expect(invited.status).toBe(403);
    expect(await invited.json()).toMatchObject({
      code: 'INVITATIONS_UNAVAILABLE',
      message: 'Invitations are unavailable until email sending is set up.',
    });
    expect(await invitationsIn(organizationId)).toEqual([]);
  });

  it('in production with no allowlist refuses every sign-up but still signs existing users in', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('MELOS_SIGNUP_ALLOWED_EMAILS', '');
    vi.resetModules();
    await loadAuthRoute();

    expect((await signUp(newcomer)).status).toBe(422);
    expect(await usersWithEmail(newcomer)).toEqual([]);
    const signIn = await new TestClient().call(authRoute.POST, 'POST', '/api/auth/sign-in/email', {
      email: listed,
      password,
    });
    expect(signIn.status).toBe(200);
  });

  it('sends no email and logs neither the allowlist nor a refused address', () => {
    console.error('log capture check');
    expect(logs).toContain('log capture check');

    const logged = logs.join('\n').toLowerCase();
    for (const secret of [unlisted, newcomer, 'other@example.com', 'auth email is off']) {
      expect(logged).not.toContain(secret);
    }
    expect(outboxFiles()).toEqual(outboxBefore);
  });
});
