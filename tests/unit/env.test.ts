import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseServerEnv,
  requireChatModel,
  ServerEnvError,
  TEST_CHAT_MODEL_ID,
} from '../../src/server/env';

const SECRET = 'unit-test-secret-value-that-is-long-enough';
const TEST_MODEL = { BETTER_AUTH_SECRET: SECRET, MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1' };
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');

/** The URLs @libsql/client's HTTP transport requests for a database URL, from a stub fetch. */
async function requestedBy(url: string): Promise<string[]> {
  const requested: string[] = [];
  const fetch = async (request: Request) => {
    requested.push(request.url);
    return new Response('stub', { status: 500, headers: { 'content-type': 'text/plain' } });
  };
  const client = createClient({ url, fetch });
  await client.execute('SELECT 1').catch(() => undefined);
  client.close();
  return requested;
}

/** The paths @libsql/client's WebSocket transport opens for `path`, seen by a local server. */
async function socketPathsFor(path: string): Promise<string[]> {
  const opened = new Set<string>();
  const server = createServer().on('upgrade', (request, socket) => {
    opened.add(String(request.url));
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const client = createClient({ url: `ws://127.0.0.1:${port}${path}` });
  await client.execute('SELECT 1').catch(() => undefined);
  client.close();
  server.close();
  return [...opened];
}

function problemsOf(source: Record<string, string | undefined>) {
  try {
    parseServerEnv(source);
  } catch (error) {
    if (error instanceof ServerEnvError) return error;
  }
  throw new Error('expected a ServerEnvError');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseServerEnv', () => {
  it('uses local file databases and localhost when nothing else is set', () => {
    const env = parseServerEnv({
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CHAT_MODEL: 'anthropic/claude-haiku-4.5',
      AI_GATEWAY_API_KEY: 'gateway-key-for-test',
    });
    expect(env.onVercel).toBe(false);
    expect(env.auth.baseURL).toBe('http://localhost:3100');
    expect(env.controlDatabase).toEqual({
      url: 'file:./data/control.db',
      authToken: undefined,
    });
    expect(env.agentDatabase).toEqual({
      url: 'file:./data/agent.db',
      authToken: undefined,
    });
    expect(env.workspaceHost).toEqual({ kind: 'local', dataDir: '.data' });
    expect(env.chatModel).toEqual({
      provider: 'gateway',
      id: 'anthropic/claude-haiku-4.5',
      apiKey: 'gateway-key-for-test',
    });
    expect(env.emailTransport).toBe('sandbox');
  });

  it('points the chat model at the test endpoint when MELOS_LLM_BASE_URL is set', () => {
    const env = parseServerEnv({
      BETTER_AUTH_SECRET: SECRET,
      MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1',
      MELOS_CONTROL_DATABASE_AUTH_TOKEN: '',
    });
    expect(env.chatModel).toEqual({
      provider: 'openai-compatible',
      id: TEST_CHAT_MODEL_ID,
      url: 'http://127.0.0.1:4010/v1',
    });
    expect(env.controlDatabase.authToken).toBeUndefined();
  });

  it('lists every missing name without printing any value', () => {
    const error = problemsOf({ BETTER_AUTH_SECRET: 'short-secret-value' });
    // The chat model's variables are checked by requireChatModel, not here.
    expect(error.problems.map((p) => p.name)).toEqual(['BETTER_AUTH_SECRET']);
    expect(error.message).toContain('BETTER_AUTH_SECRET');
    expect(error.message).not.toContain('short-secret-value');
  });

  it('places workspace files in MELOS_WORKSPACE_DATA_DIR and refuses a bad token key by name', () => {
    const env = parseServerEnv({ ...TEST_MODEL, MELOS_WORKSPACE_DATA_DIR: '.data/dev' });
    expect(env.workspaceHost).toEqual({ kind: 'local', dataDir: '.data/dev' });
    const shortKey = Buffer.alloc(16, 7).toString('base64');
    const error = problemsOf({ ...TEST_MODEL, MELOS_WORKSPACE_TOKEN_KEY: shortKey });
    expect(error.message).toContain('MELOS_WORKSPACE_TOKEN_KEY must be 32 bytes encoded as base64');
    expect(error.message).not.toContain(shortKey);
  });

  it('compares remote URLs by the endpoints the installed @libsql/client requests', async () => {
    // HTTP resolves v2/pipeline against the base URL; a WebSocket opens the base URL as it is.
    const requests = [];
    for (const url of [
      'https://example.invalid/control',
      'https://example.invalid/agent',
      'https://example.invalid/control/',
      'libsql://Melos-Control.example.turso.io',
    ]) {
      requests.push(await requestedBy(url));
    }
    expect(requests).toEqual([
      ['https://example.invalid/v2/pipeline'],
      ['https://example.invalid/v2/pipeline'],
      ['https://example.invalid/control/v2/pipeline'],
      ['https://melos-control.example.turso.io/v2/pipeline'],
    ]);
    expect([await socketPathsFor('/control'), await socketPathsFor('')]).toEqual([
      ['/control'],
      ['/'],
    ]);
  });

  it('refuses an agent database URL that reaches the control database as libSQL sends it (TEN-006)', () => {
    const urls = (control?: string, agent?: string) => ({
      ...TEST_MODEL,
      MELOS_CONTROL_DATABASE_URL: control,
      MELOS_AGENT_DATABASE_URL: agent,
    });
    const reason = 'must not name the control database';
    const same = [
      [undefined, 'file:data/control.db'],
      ['file:data/control.db', 'file:data/%63ontrol.db'],
      ['https://example.invalid', 'libsql://example.invalid:443'],
      ['https://example.invalid/control', 'https://example.invalid/agent'],
      ['wss://example.invalid', 'https://example.invalid'],
      ['libsql://Melos-Control.example.turso.io', 'wss://melos-control.example.turso.io/'],
      ['http://127.0.0.1:8080', 'libsql://127.0.0.1:8080?tls=0'],
    ];
    for (const [control, agent] of same) {
      const { problems } = problemsOf(urls(control, agent));
      expect(problems, agent).toEqual([{ name: 'MELOS_AGENT_DATABASE_URL', reason }]);
    }
    // Local defaults, private in-memory databases, and the Turso shapes previews and production use.
    const apart = [
      [undefined, undefined],
      ['file::memory:', 'file::memory:'],
      [':memory:', ':memory:'],
      ['libsql://melos-control-otaku.turso.io', 'libsql://melos-agent-otaku.turso.io'],
      ['https://example.invalid/control/', 'https://example.invalid/control'],
      ['wss://example.invalid/control', 'wss://example.invalid/agent'],
      ['https://example.invalid', 'https://example.invalid:8443'],
    ];
    for (const [control, agent] of apart) {
      const env = parseServerEnv(urls(control, agent));
      expect(env.agentDatabase.url).toBe(agent ?? 'file:./data/agent.db');
    }
  });

  it('checks the chat model where it is resolved, so an operator environment needs no model key', () => {
    // Off Vercel with no MELOS_LLM_BASE_URL: operator scripts parse this and never call a model.
    const operator = parseServerEnv({ BETTER_AUTH_SECRET: SECRET });
    expect(operator.chatModel).toEqual({
      provider: 'unconfigured',
      problems: [
        { name: 'MELOS_CHAT_MODEL', reason: 'is required (tests set MELOS_LLM_BASE_URL instead)' },
        { name: 'AI_GATEWAY_API_KEY', reason: 'is required off Vercel for a real model' },
      ],
    });
    expect(() => requireChatModel(operator.chatModel)).toThrow(ServerEnvError);

    const keyed = { BETTER_AUTH_SECRET: SECRET, AI_GATEWAY_API_KEY: 'gateway-key-for-test' };
    const routerSpellings = [
      'mastra/anthropic/claude-haiku-4.5',
      'vercel/anthropic/claude-haiku-4.5',
      'Anthropic/claude-haiku-4.5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-sonnet-4-5-20250929',
      'claude-haiku-4.5',
    ];
    for (const id of routerSpellings) {
      const { chatModel } = parseServerEnv({ ...keyed, MELOS_CHAT_MODEL: id });
      expect(() => requireChatModel(chatModel), id).toThrow(
        'MELOS_CHAT_MODEL must be an AI Gateway model id such as anthropic/claude-haiku-4.5',
      );
    }
    for (const id of ['anthropic/claude-haiku-4.5', 'anthropic/claude-3-haiku', 'openai/gpt-5']) {
      const { chatModel } = parseServerEnv({ ...keyed, MELOS_CHAT_MODEL: id });
      expect(requireChatModel(chatModel)).toEqual({
        provider: 'gateway',
        id,
        apiKey: keyed.AI_GATEWAY_API_KEY,
      });
    }

    // A blank key is refused, not ignored: the gateway provider would send it (model.test.ts). Off
    // Vercel only a real chat model needs the key; on Vercel any key would override OIDC.
    for (const key of ['', '   ']) {
      const blank = {
        ...keyed,
        MELOS_CHAT_MODEL: 'anthropic/claude-haiku-4.5',
        AI_GATEWAY_API_KEY: key,
      };
      expect(parseServerEnv(blank).chatModel).toEqual({
        provider: 'unconfigured',
        problems: [{ name: 'AI_GATEWAY_API_KEY', reason: 'must not be blank' }],
      });
      expect(
        problemsOf({ ...keyed, VERCEL: '1', AI_GATEWAY_API_KEY: key }).problems,
      ).toContainEqual({
        name: 'AI_GATEWAY_API_KEY',
        reason: 'must not be set on Vercel (the OIDC token authenticates the gateway)',
      });
    }
  });

  it('fails production startup while a development mailer is selected', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.resetModules();
    const { register } = await import('../../src/instrumentation');
    const failure = (await register().catch((error: unknown) => error)) as ServerEnvError;
    expect(failure.problems.map((p) => p.name)).toEqual(['MELOS_AUTH_MAILER']);
    expect(failure.message).toContain('must be disabled in production');
  });

  it('accepts the disabled mailer everywhere and only it in production', () => {
    for (const mailer of ['outbox', 'memory', undefined]) {
      const error = problemsOf({
        ...TEST_MODEL,
        VERCEL_ENV: 'production',
        MELOS_AUTH_MAILER: mailer,
      });
      expect(error.problems.map((p) => p.name)).toEqual(['MELOS_AUTH_MAILER']);
    }
    for (const VERCEL_ENV of ['production', 'preview', undefined]) {
      const env = parseServerEnv({ ...TEST_MODEL, VERCEL_ENV, MELOS_AUTH_MAILER: 'disabled' });
      expect(env.authMailer).toBe('disabled');
    }
  });

  it('parses the sign-up allowlist and fails closed in production when it is unset', () => {
    const listed = parseServerEnv({
      ...TEST_MODEL,
      MELOS_SIGNUP_ALLOWED_EMAILS: ' Owner@Example.com, ,team@example.com,',
    });
    expect(listed.signUpAllowedEmails).toEqual(['owner@example.com', 'team@example.com']);
    expect(parseServerEnv(TEST_MODEL).signUpAllowedEmails).toBeNull();
    expect(
      parseServerEnv({ ...TEST_MODEL, MELOS_SIGNUP_ALLOWED_EMAILS: ' ' }).signUpAllowedEmails,
    ).toBeNull();

    const production = { ...TEST_MODEL, VERCEL_ENV: 'production', MELOS_AUTH_MAILER: 'disabled' };
    expect(parseServerEnv(production).signUpAllowedEmails).toEqual([]);
    expect(
      parseServerEnv({ ...production, MELOS_SIGNUP_ALLOWED_EMAILS: 'owner@example.com' })
        .signUpAllowedEmails,
    ).toEqual(['owner@example.com']);
  });

  it('selects local assets off Vercel and r2 on Vercel, where local is refused (D-7)', () => {
    const local = parseServerEnv({ ...TEST_MODEL, MELOS_WORKSPACE_DATA_DIR: 'data/ws' });
    expect(local.assetStorage).toEqual({ kind: 'local', rootDir: 'data/ws/assets' });
    const r2 = parseServerEnv({ ...TEST_MODEL, MELOS_ASSET_STORAGE: 'r2' });
    expect(r2.assetStorage).toEqual({ kind: 'r2' });
    expect(problemsOf({ ...TEST_MODEL, MELOS_ASSET_STORAGE: 's3' }).problems).toEqual([
      { name: 'MELOS_ASSET_STORAGE', reason: 'must be one of: local, r2' },
    ]);
    // Production starts with no asset variable; the storage call reports what is missing.
    const production = {
      BETTER_AUTH_SECRET: SECRET,
      VERCEL: '1',
      VERCEL_ENV: 'production',
      MELOS_AUTH_MAILER: 'disabled',
      MELOS_CONTROL_DATABASE_URL: 'libsql://control-example.turso.io',
      MELOS_CONTROL_DATABASE_AUTH_TOKEN: 'control-token-for-test',
      MELOS_AGENT_DATABASE_URL: 'libsql://agent-example.turso.io',
      MELOS_AGENT_DATABASE_AUTH_TOKEN: 'agent-token-for-test',
    };
    expect(parseServerEnv(production).assetStorage).toEqual({ kind: 'r2' });
    expect(problemsOf({ ...production, MELOS_ASSET_STORAGE: 'local' }).problems).toEqual([
      {
        name: 'MELOS_ASSET_STORAGE',
        reason: 'must not be local on Vercel (local files are not allowed)',
      },
    ]);
  });

  it('refuses local files, the local workspace host, the test model endpoint and a gateway key on Vercel', () => {
    const error = problemsOf({
      VERCEL: '1',
      VERCEL_URL: 'melos-abc123.vercel.app',
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CONTROL_DATABASE_URL: 'file:./data/control.db',
      MELOS_WORKSPACE_DATA_DIR: '.data/workspaces',
      MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1',
      AI_GATEWAY_API_KEY: 'gateway-key-for-test',
    });
    expect(error.message).not.toContain('gateway-key-for-test');
    expect(error.problems.map((p) => p.name).sort()).toEqual([
      'AI_GATEWAY_API_KEY',
      'MELOS_AGENT_DATABASE_AUTH_TOKEN',
      'MELOS_AGENT_DATABASE_URL',
      'MELOS_CONTROL_DATABASE_AUTH_TOKEN',
      'MELOS_CONTROL_DATABASE_URL',
      'MELOS_LLM_BASE_URL',
      'MELOS_WORKSPACE_DATA_DIR',
    ]);
    expect(error.message).not.toContain('file:./data/control.db');
    expect(error.message).not.toContain('.data/workspaces');
  });

  it('derives the auth URL and trusted origins from Vercel system variables', () => {
    const vercel = {
      VERCEL: '1',
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CONTROL_DATABASE_URL: 'libsql://control-example.turso.io',
      MELOS_CONTROL_DATABASE_AUTH_TOKEN: 'control-token-for-test',
      MELOS_AGENT_DATABASE_URL: 'libsql://agent-example.turso.io',
      MELOS_AGENT_DATABASE_AUTH_TOKEN: 'agent-token-for-test',
      MELOS_CHAT_MODEL: 'anthropic/claude-haiku-4.5',
      VERCEL_URL: 'melos-abc123-otaku.vercel.app',
    };

    const branch = parseServerEnv({
      ...vercel,
      VERCEL_BRANCH_URL: 'melos-git-feat-otaku.vercel.app',
    });
    expect(branch.onVercel).toBe(true);
    // No key on Vercel: the gateway authenticates with the deployment's OIDC token.
    expect(branch.chatModel).toEqual({ provider: 'gateway', id: 'anthropic/claude-haiku-4.5' });
    // Vercel starts without the Turso variables; the host names the missing ones when used.
    const missing = ['TURSO_API_TOKEN', 'TURSO_ORG', 'MELOS_WORKSPACE_TOKEN_KEY'];
    expect(branch.workspaceHost).toEqual({ kind: 'unconfigured', missing });
    const turso = { ...vercel, TURSO_API_TOKEN: 'api-token-for-test', TURSO_ORG: 'example-org' };
    expect(parseServerEnv(turso).workspaceHost).toEqual({
      kind: 'unconfigured',
      missing: [missing[2]],
    });
    expect(
      parseServerEnv({ ...turso, MELOS_WORKSPACE_TOKEN_KEY: TOKEN_KEY }).workspaceHost,
    ).toEqual({
      kind: 'turso',
      apiToken: 'api-token-for-test',
      organization: 'example-org',
      group: 'default',
      tokenKey: TOKEN_KEY,
    });
    // A gateway key alone still fails this environment; operator scripts drop it first.
    const keyed = {
      ...turso,
      MELOS_WORKSPACE_TOKEN_KEY: TOKEN_KEY,
      AI_GATEWAY_API_KEY: 'gateway-key',
    };
    expect(problemsOf(keyed).problems).toEqual([
      {
        name: 'AI_GATEWAY_API_KEY',
        reason: 'must not be set on Vercel (the OIDC token authenticates the gateway)',
      },
    ]);
    expect(branch.auth.baseURL).toBe('https://melos-git-feat-otaku.vercel.app');
    expect(branch.auth.trustedOrigins).toEqual([
      'https://melos-git-feat-otaku.vercel.app',
      'https://melos-abc123-otaku.vercel.app',
    ]);
    expect(parseServerEnv({ ...vercel, VERCEL_ENV: 'preview' }).authMailer).toBe('outbox');

    expect(parseServerEnv(vercel).auth.baseURL).toBe('https://melos-abc123-otaku.vercel.app');

    const explicit = parseServerEnv({
      ...vercel,
      BETTER_AUTH_URL: 'https://melos.example.com',
    });
    expect(explicit.auth.baseURL).toBe('https://melos.example.com');
    expect(explicit.auth.trustedOrigins).toContain('https://melos-abc123-otaku.vercel.app');

    const withProductionDomain = {
      ...vercel,
      VERCEL_BRANCH_URL: 'melos-git-main-otaku.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'melos-otaku.vercel.app',
    };
    const preview = parseServerEnv({ ...withProductionDomain, VERCEL_ENV: 'preview' });
    expect(preview.auth.baseURL).toBe('https://melos-git-main-otaku.vercel.app');

    const production = parseServerEnv({
      ...withProductionDomain,
      VERCEL_ENV: 'production',
      MELOS_AUTH_MAILER: 'disabled',
    });
    expect(production.auth.baseURL).toBe('https://melos-otaku.vercel.app');
    expect(production.auth.trustedOrigins).toEqual([
      'https://melos-otaku.vercel.app',
      'https://melos-git-main-otaku.vercel.app',
      'https://melos-abc123-otaku.vercel.app',
    ]);
  });
});
