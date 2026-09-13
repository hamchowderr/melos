import { describe, expect, it } from 'vitest';
import { isChatRunErrorCode, toChatRunError } from '../../src/lib/agent/run-error';

describe('toChatRunError', () => {
  it.each([
    [
      'credits',
      'AI_APICallError: Insufficient credits. Add more using https://openrouter.ai/credits',
    ],
    ['credits', 'You exceeded your current quota, please check your plan and billing details.'],
    ['credits', 'Request failed with status 402 Payment Required'],
    [
      'rate_limit',
      'Rate limit reached for gpt-4o-mini in organization org-123 on requests per min',
    ],
    ['rate_limit', '429 Too Many Requests'],
    ['auth', 'Incorrect API key provided: sk-proj-****abcd.'],
    ['auth', '401 Unauthorized'],
  ] as const)('maps a provider failure to %s', (kind, providerText) => {
    const mapped = toChatRunError('agent_run_error_event', new Error(providerText));
    expect(mapped.kind).toBe(kind);
    expect(mapped.message).not.toContain(providerText);
  });

  it('never echoes raw payloads, keys or stack traces in the fallback', () => {
    const raw = new Error(
      '{"error":{"message":"boom","key":"sk-live-123"}}\n    at stream (x.js:1:1)',
    );
    const mapped = toChatRunError('agent_run_failed', raw);
    expect(mapped).toEqual({
      kind: 'unknown',
      message: 'Melos could not finish that answer. Try again.',
    });
    expect(mapped.message).not.toMatch(/sk-live|boom|at stream/);
  });

  it('treats a locked thread as busy, whatever the error text says', () => {
    expect(toChatRunError('agent_thread_locked', new Error('credits')).kind).toBe('busy');
  });

  it('falls back when the error has no usable message', () => {
    expect(toChatRunError('agent_run_failed', undefined).kind).toBe('unknown');
    expect(toChatRunError('agent_run_failed', { message: 42 }).kind).toBe('unknown');
  });
});

describe('isChatRunErrorCode', () => {
  it('accepts run failures and ignores tool and transcription errors', () => {
    expect(isChatRunErrorCode('agent_run_error_event')).toBe(true);
    expect(isChatRunErrorCode('agent_thread_locked')).toBe(true);
    expect(isChatRunErrorCode('tool_handler_failed')).toBe(false);
    expect(isChatRunErrorCode('transcription_failed')).toBe(false);
  });
});
