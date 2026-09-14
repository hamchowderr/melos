import { createGateway } from '@ai-sdk/gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toModelConfig } from '../../src/mastra/model';
import { parseServerEnv, requireChatModel, TEST_CHAT_MODEL_ID } from '../../src/server/env';

const SECRET = 'unit-test-secret-value-that-is-long-enough';
const MODEL = 'anthropic/claude-haiku-4.5';
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const VERCEL = {
  VERCEL: '1',
  BETTER_AUTH_SECRET: SECRET,
  MELOS_CONTROL_DATABASE_URL: 'libsql://control-example.turso.io',
  MELOS_CONTROL_DATABASE_AUTH_TOKEN: 'control-token-for-test',
  MELOS_AGENT_DATABASE_URL: 'libsql://agent-example.turso.io',
  MELOS_AGENT_DATABASE_AUTH_TOKEN: 'agent-token-for-test',
  MELOS_CHAT_MODEL: MODEL,
};

type GatewayModel = ReturnType<ReturnType<typeof createGateway>>;

/** An unsigned JWT that @vercel/oidc reads as unexpired, so it never tries to refresh it. */
function oidcToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600 })}.unsigned`;
}

/**
 * Sends one call through the real @ai-sdk/gateway model to a stubbed fetch, with `requestToken`
 * as the Vercel Function request's x-vercel-oidc-token header, and returns how it authenticated.
 */
async function authOf(model: unknown, requestToken: string) {
  const sent: Headers[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers));
    return Response.json(
      { error: { message: 'stub', type: 'authentication_error' } },
      { status: 401 },
    );
  });
  const context = { get: () => ({ headers: { 'x-vercel-oidc-token': requestToken } }) };
  (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT] = context;
  const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'ping' }] }];
  await Promise.resolve((model as GatewayModel).doGenerate({ prompt })).catch(() => undefined);
  expect(sent).toHaveLength(1);
  return {
    method: sent[0]?.get('ai-gateway-auth-method'),
    authorization: sent[0]?.get('authorization'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
});

describe('toModelConfig through the real @ai-sdk/gateway (stubbed fetch, no network)', () => {
  it('authenticates with the request OIDC token on Vercel, even if AI_GATEWAY_API_KEY appears later', async () => {
    const model = toModelConfig(requireChatModel(parseServerEnv(VERCEL).chatModel));
    vi.stubEnv('AI_GATEWAY_API_KEY', 'stray-key-set-after-startup');
    const token = oidcToken();
    expect(await authOf(model, token)).toEqual({
      method: 'oidc',
      authorization: `Bearer ${token}`,
    });
  });

  it('authenticates off Vercel with AI_GATEWAY_API_KEY as an api-key, over an OIDC token', async () => {
    const env = parseServerEnv({
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CHAT_MODEL: MODEL,
      AI_GATEWAY_API_KEY: 'gateway-key-for-test',
    });
    const model = toModelConfig(requireChatModel(env.chatModel));
    expect(await authOf(model, oidcToken())).toEqual({
      method: 'api-key',
      authorization: 'Bearer gateway-key-for-test',
    });
  });

  it('refuses a whitespace key on Vercel, which the provider would send over the OIDC token', async () => {
    // Given no apiKey, the provider reads AI_GATEWAY_API_KEY from the environment, whitespace too.
    vi.stubEnv('AI_GATEWAY_API_KEY', '   ');
    expect((await authOf(createGateway()(MODEL), oidcToken())).method).toBe('api-key');
    expect(() => parseServerEnv({ ...VERCEL, AI_GATEWAY_API_KEY: '   ' })).toThrow(
      /AI_GATEWAY_API_KEY must not be set on Vercel/,
    );
  });

  it('serves the AIMock endpoint as an OpenAI-compatible model, never through the gateway', () => {
    const url = 'http://127.0.0.1:4010/v1';
    const env = parseServerEnv({ BETTER_AUTH_SECRET: SECRET, MELOS_LLM_BASE_URL: url });
    expect(toModelConfig(requireChatModel(env.chatModel))).toEqual({
      id: TEST_CHAT_MODEL_ID,
      url,
      apiKey: 'melos-test-endpoint-no-key',
    });
  });
});
