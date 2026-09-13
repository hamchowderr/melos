import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerEnv, ServerEnvError, TEST_CHAT_MODEL_ID } from '../../src/server/env';

const SECRET = 'unit-test-secret-value-that-is-long-enough';
const TEST_MODEL = { BETTER_AUTH_SECRET: SECRET, MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1' };
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');

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
      MELOS_CHAT_MODEL: 'mastra/anthropic/claude-haiku-4.5',
      MASTRA_GATEWAY_API_KEY: 'gateway-key-for-test',
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
      provider: 'router',
      id: 'mastra/anthropic/claude-haiku-4.5',
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
    expect(error.problems.map((p) => p.name).sort()).toEqual([
      'BETTER_AUTH_SECRET',
      'MELOS_CHAT_MODEL',
    ]);
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

  it('requires the gateway key for a Mastra Gateway model', () => {
    const error = problemsOf({
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CHAT_MODEL: 'mastra/anthropic/claude-haiku-4.5',
    });
    expect(error.problems.map((p) => p.name)).toEqual(['MASTRA_GATEWAY_API_KEY']);
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

  it('refuses local files, the local workspace host and the test model endpoint on Vercel', () => {
    const error = problemsOf({
      VERCEL: '1',
      VERCEL_URL: 'melos-abc123.vercel.app',
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CONTROL_DATABASE_URL: 'file:./data/control.db',
      MELOS_WORKSPACE_DATA_DIR: '.data/workspaces',
      MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1',
    });
    expect(error.problems.map((p) => p.name).sort()).toEqual([
      'MELOS_AGENT_DATABASE_AUTH_TOKEN',
      'MELOS_AGENT_DATABASE_URL',
      'MELOS_CONTROL_DATABASE_AUTH_TOKEN',
      'MELOS_CONTROL_DATABASE_URL',
      'MELOS_LLM_BASE_URL',
      'MELOS_WORKSPACE_DATA_DIR',
      'MELOS_WORKSPACE_TOKEN_KEY',
      'TURSO_API_TOKEN',
      'TURSO_ORG',
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
      TURSO_API_TOKEN: 'platform-token-for-test',
      TURSO_ORG: 'example-org',
      MELOS_WORKSPACE_TOKEN_KEY: TOKEN_KEY,
      MELOS_CHAT_MODEL: 'mastra/anthropic/claude-haiku-4.5',
      MASTRA_GATEWAY_API_KEY: 'gateway-key-for-test',
      VERCEL_URL: 'melos-abc123-otaku.vercel.app',
    };

    const branch = parseServerEnv({
      ...vercel,
      VERCEL_BRANCH_URL: 'melos-git-feat-otaku.vercel.app',
    });
    expect(branch.onVercel).toBe(true);
    expect(branch.workspaceHost).toEqual({
      kind: 'turso',
      apiToken: 'platform-token-for-test',
      organization: 'example-org',
      group: 'default',
      tokenKey: TOKEN_KEY,
    });
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
