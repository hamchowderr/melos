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

  it('validates an operator environment with no chat model and an unset or blank gateway key', async () => {
    // Off Vercel with no MELOS_LLM_BASE_URL: operator scripts call no model, so they need no key.
    try {
      for (const key of [undefined, '', '   ']) {
        for (const name of ['VERCEL', 'MELOS_LLM_BASE_URL', 'MELOS_CHAT_MODEL']) {
          vi.stubEnv(name, undefined);
        }
        vi.stubEnv('AI_GATEWAY_API_KEY', key);
        vi.resetModules();
        const operator = await import('../../scripts/operator');
        const exitCode = await operator.runOperatorCommand([], () =>
          operator.withControl(async ({ env }) =>
            env.chatModel.provider === 'unconfigured' ? 0 : 3,
          ),
        );
        expect(exitCode, JSON.stringify(key)).toBe(0);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops AI_GATEWAY_API_KEY so a run with VERCEL set and the Turso host validates (ADR-034)', async () => {
    // Operators set VERCEL=1 for the Turso host; `infisical run --path=/melos` also injects the
    // shared gateway key, which startup refuses on Vercel. Operator commands call no model.
    const operatorEnv = {
      VERCEL: '1',
      MELOS_CONTROL_DATABASE_URL: 'https://control.example.invalid',
      MELOS_CONTROL_DATABASE_AUTH_TOKEN: 'control-token-for-test',
      MELOS_AGENT_DATABASE_URL: 'https://agent.example.invalid',
      MELOS_AGENT_DATABASE_AUTH_TOKEN: 'agent-token-for-test',
      MELOS_WORKSPACE_DATA_DIR: undefined,
      MELOS_LLM_BASE_URL: undefined,
      MELOS_CHAT_MODEL: undefined,
      TURSO_API_TOKEN: 'api-token-for-test',
      TURSO_ORG: 'example-org',
      MELOS_WORKSPACE_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
      AI_GATEWAY_API_KEY: 'gateway-key-for-test',
    };
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [name, value] of Object.entries(operatorEnv)) vi.stubEnv(name, value);
      vi.resetModules();
      const operator = await import('../../scripts/operator');
      let seen: unknown;
      // The HTTP client sends nothing until a query, and `work` runs none.
      const exitCode = await operator.runOperatorCommand([], () =>
        operator.withControl(async ({ env }) => {
          const key = 'AI_GATEWAY_API_KEY' in process.env;
          seen = { key, onVercel: env.onVercel, host: env.workspaceHost.kind };
          return 0;
        }),
      );
      expect(stderr).not.toHaveBeenCalled();
      expect(exitCode).toBe(0);
      expect(seen).toEqual({ key: false, onVercel: true, host: 'turso' });
    } finally {
      vi.unstubAllEnvs();
      stderr.mockRestore();
    }
  });
});
