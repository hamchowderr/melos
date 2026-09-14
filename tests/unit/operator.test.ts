import { describe, expect, it, vi } from 'vitest';
import { runOperatorCommand } from '../../scripts/operator';

const MARKER = 'libsql://operator:secret-looking-marker@example.test';

describe('operator scripts print only error names and codes (ADR-032)', () => {
  it('reports a throwing close without its message, exits nonzero and never rejects', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const close = () => {
      throw Object.assign(new Error(`close failed for ${MARKER}`), { code: 'CLOSE_FAILED' });
    };
    const throwing = async (): Promise<number> => {
      throw new TypeError(`query failed for ${MARKER}`);
    };
    try {
      // A close failure turns 0 into 1 and keeps the command's own nonzero code.
      expect(await runOperatorCommand([], async () => 0, close)).toBe(1);
      expect(await runOperatorCommand([], async () => 2, close)).toBe(2);
      expect(await runOperatorCommand([], throwing, close)).toBe(1);
      await new Promise((settled) => setImmediate(settled));
      const closeFailed = ['Failed: Error CLOSE_FAILED'];
      const printed = [closeFailed, closeFailed, ['Failed: TypeError'], closeFailed];
      expect(stderr.mock.calls).toEqual(printed);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret-looking-marker');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      stderr.mockRestore();
    }
  });

  it('validates an operator environment that has no chat model or gateway key', async () => {
    // Off Vercel with no MELOS_LLM_BASE_URL: operator scripts call no model, so they need no key.
    for (const name of ['VERCEL', 'MELOS_LLM_BASE_URL', 'MELOS_CHAT_MODEL', 'AI_GATEWAY_API_KEY']) {
      vi.stubEnv(name, undefined);
    }
    vi.resetModules();
    try {
      const operator = await import('../../scripts/operator');
      const exitCode = await operator.runOperatorCommand([], () =>
        operator.withControl(async ({ env }) =>
          env.chatModel.provider === 'unconfigured' ? 0 : 3,
        ),
      );
      expect(exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
