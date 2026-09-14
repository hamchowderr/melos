import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toModelConfig } from '../../src/mastra/model';
import { parseServerEnv, TEST_CHAT_MODEL_ID } from '../../src/server/env';

const { createGateway, gatewayModel } = vi.hoisted(() => {
  const gatewayModel = vi.fn((modelId: string) => ({ specificationVersion: 'v3', modelId }));
  return { gatewayModel, createGateway: vi.fn((_options: { apiKey?: string }) => gatewayModel) };
});
vi.mock('@ai-sdk/gateway', () => ({ createGateway }));

const SECRET = 'unit-test-secret-value-that-is-long-enough';
const MODEL = 'anthropic/claude-haiku-4.5';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toModelConfig', () => {
  it('builds a gateway model without a key on Vercel, so the provider uses the OIDC token', () => {
    const env = parseServerEnv({
      VERCEL: '1',
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CONTROL_DATABASE_URL: 'libsql://control-example.turso.io',
      MELOS_CONTROL_DATABASE_AUTH_TOKEN: 'control-token-for-test',
      MELOS_AGENT_DATABASE_URL: 'libsql://agent-example.turso.io',
      MELOS_AGENT_DATABASE_AUTH_TOKEN: 'agent-token-for-test',
      MELOS_CHAT_MODEL: MODEL,
    });
    expect(toModelConfig(env.chatModel)).toEqual({ specificationVersion: 'v3', modelId: MODEL });
    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway.mock.calls[0]?.[0].apiKey).toBeUndefined();
    expect(gatewayModel).toHaveBeenCalledWith(MODEL);
  });

  it('passes AI_GATEWAY_API_KEY to the gateway off Vercel', () => {
    const env = parseServerEnv({
      BETTER_AUTH_SECRET: SECRET,
      MELOS_CHAT_MODEL: MODEL,
      AI_GATEWAY_API_KEY: 'gateway-key-for-test',
    });
    expect(toModelConfig(env.chatModel)).toEqual({ specificationVersion: 'v3', modelId: MODEL });
    expect(createGateway).toHaveBeenCalledWith({ apiKey: 'gateway-key-for-test' });
    expect(gatewayModel).toHaveBeenCalledWith(MODEL);
  });

  it('serves the AIMock endpoint as an OpenAI-compatible model, never through the gateway', () => {
    const url = 'http://127.0.0.1:4010/v1';
    const env = parseServerEnv({ BETTER_AUTH_SECRET: SECRET, MELOS_LLM_BASE_URL: url });
    expect(toModelConfig(env.chatModel)).toEqual({
      id: TEST_CHAT_MODEL_ID,
      url,
      apiKey: 'melos-test-endpoint-no-key',
    });
    expect(createGateway).not.toHaveBeenCalled();
  });
});
