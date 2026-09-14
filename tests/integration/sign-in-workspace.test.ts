import type { LLMock } from '@copilotkit/aimock';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { member } from '../../src/server/db/schema/auth';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type AuthBody = { id: string; user: { id: string } };
type Person = { email: string; userId: string };

const stamp = Date.now();
const password = 'integration-password-123';
let mock: LLMock;
let authRoute: { POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let controlDb: typeof import('../../src/server/db/client').controlDb;
let listMemberships: typeof import('../../src/server/services/memberships').listMemberships;

beforeAll(async () => {
  mock = await prepareTestEnvironment('sign-in-workspace');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ controlDb } = await import('../../src/server/db/client'));
  ({ listMemberships } = await import('../../src/server/services/memberships'));
});

afterAll(async () => {
  await mock?.stop();
});

async function post(client: TestClient, path: string, body: object): Promise<AuthBody> {
  const response = await client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  expect(response.status, path).toBe(200);
  return (await response.json()) as AuthBody;
}

async function signUp(label: string): Promise<Person> {
  const email = `${label}-${stamp}@example.test`;
  const { user } = await post(new TestClient(), '/sign-up/email', { email, password, name: label });
  return { email, userId: user.id };
}

/** Signs in from a new client, as a fresh browser does; returns it and the session's workspace. */
async function signIn({ email }: Person) {
  const client = new TestClient();
  await post(client, '/sign-in/email', { email, password });
  const current = await auth.api.getSession({ headers: client.headers() });
  return { client, active: current?.session.activeOrganizationId ?? null };
}

const createWorkspace = async (client: TestClient, name: string) =>
  (await post(client, '/organization/create', { name, slug: `${name}-${stamp}` })).id;

describe('melos-2lm: a new session opens the only workspace its user is a member of (§7.1)', () => {
  let owner: Person;
  let ownerClient: TestClient;
  let alpha = '';

  it('opens no workspace for a user with none', async () => {
    owner = await signUp('owner');
    const signedIn = await signIn(owner);
    expect(signedIn.active).toBeNull();
    ownerClient = signedIn.client;
    alpha = await createWorkspace(ownerClient, 'alpha');
  });

  it('opens the workspace of a user with exactly one', async () => {
    expect((await signIn(owner)).active).toBe(alpha);
  });

  it('never opens a workspace the user is not a member of', async () => {
    const other = await signIn(await signUp('other'));
    const beta = await createWorkspace(other.client, 'beta');
    const teammate = await signUp('teammate');
    const body = { userId: teammate.userId, organizationId: beta, role: 'member' as const };
    await auth.api.addMember({ body });

    // Alpha and beta both exist: the member of beta opens beta, a user in neither opens none.
    expect((await signIn(teammate)).active).toBe(beta);
    expect((await signIn(await signUp('outsider'))).active).toBeNull();
  });

  it('opens no workspace for a user with two, who picks one at /workspaces', async () => {
    await createWorkspace(ownerClient, 'gamma');
    expect((await signIn(owner)).active).toBeNull();
  });
});

describe('melos-g4u: a membership with an invalid role is never listed or opened (P-30)', () => {
  const invalidRoles = ['owner,viewer', 'superuser'];
  let person: Person;
  let client: TestClient;
  let delta = '';

  /** Writes the role straight to the control database, past singleRolePlugin. */
  const setDeltaRole = (role: string) => {
    const row = and(eq(member.userId, person.userId), eq(member.organizationId, delta));
    return controlDb.update(member).set({ role }).where(row);
  };

  it('lists and opens nothing when that is the only membership', async () => {
    person = await signUp('misrole');
    ({ client } = await signIn(person));
    delta = await createWorkspace(client, 'delta');
    for (const role of invalidRoles) {
      await setDeltaRole(role);
      expect(await listMemberships(person.userId)).toEqual([]);
      expect((await signIn(person)).active).toBeNull();
    }
  });

  it('lists and opens the one valid membership beside it', async () => {
    const epsilon = await createWorkspace(client, 'epsilon');
    for (const role of invalidRoles) {
      await setDeltaRole(role);
      const valid = { organizationId: epsilon, name: 'epsilon', role: 'owner' };
      expect(await listMemberships(person.userId)).toEqual([valid]);
      expect((await signIn(person)).active).toBe(epsilon);
    }
  });
});
