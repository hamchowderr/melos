import { createGateway } from '@ai-sdk/gateway';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChatModelSetting } from '../server/env';

// The OpenAI-compatible endpoint is a test server (AIMock); no real key is ever sent to it.
const TEST_ENDPOINT_API_KEY = 'melos-test-endpoint-no-key';

/**
 * Real models go through the Vercel AI Gateway as an AI SDK model (ADR-034); a `vercel/` Mastra
 * router string would require AI_GATEWAY_API_KEY. Without a key (on Vercel) the model uses the
 * deployment's OIDC token: `apiKey: ''` is a string, so @ai-sdk/gateway 3.0.193 does not read
 * AI_GATEWAY_API_KEY from the environment, and falsy, so it sends the token instead
 * (tests/unit/model.test.ts).
 */
export function toModelConfig(setting: ChatModelSetting): MastraModelConfig {
  if (setting.provider === 'openai-compatible') {
    return {
      id: setting.id as `${string}/${string}`,
      url: setting.url,
      apiKey: TEST_ENDPOINT_API_KEY,
    };
  }
  return createGateway({ apiKey: setting.apiKey ?? '' })(setting.id);
}
