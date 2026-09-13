import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChatModelSetting } from '../server/env';

// The OpenAI-compatible endpoint is a test server (AIMock); no real key is ever sent to it.
const TEST_ENDPOINT_API_KEY = 'melos-test-endpoint-no-key';

/**
 * Production and previews pass a Mastra model router string (e.g. a Mastra Gateway model);
 * the router reads that provider's key from the environment itself.
 */
export function toModelConfig(setting: ChatModelSetting): MastraModelConfig {
  if (setting.provider === 'openai-compatible') {
    return {
      id: setting.id as `${string}/${string}`,
      url: setting.url,
      apiKey: TEST_ENDPOINT_API_KEY,
    };
  }
  return setting.id as `${string}/${string}`;
}
