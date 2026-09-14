import { createGateway } from '@ai-sdk/gateway';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChatModelSetting } from '../server/env';

// The OpenAI-compatible endpoint is a test server (AIMock); no real key is ever sent to it.
const TEST_ENDPOINT_API_KEY = 'melos-test-endpoint-no-key';

/**
 * Real models go through the Vercel AI Gateway as an AI SDK model (ADR-034). A `vercel/` Mastra
 * router string would need AI_GATEWAY_API_KEY; with no key (on Vercel) this provider reads the
 * deployment's OIDC token on each request.
 */
export function toModelConfig(setting: ChatModelSetting): MastraModelConfig {
  if (setting.provider === 'openai-compatible') {
    return {
      id: setting.id as `${string}/${string}`,
      url: setting.url,
      apiKey: TEST_ENDPOINT_API_KEY,
    };
  }
  return createGateway({ apiKey: setting.apiKey })(setting.id);
}
