import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowServedRoutesOnly, SERVED_COPILOT_ROUTES } from '../../src/server/agent/route-guard';

const ROOT = resolve(import.meta.dirname, '../..');
const API = join(ROOT, 'src', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [relative(API, path).split('\\').join('/')] : [];
  });
}

// AUTH-009: Mastra stays embedded (ADR-016). No Mastra server routes or Studio are deployed.
describe('agent surface (AUTH-009)', () => {
  it('exposes only the auth, asset and CopilotKit API routes', () => {
    expect(routeFiles(API).sort()).toEqual([
      'assets/local/[...key]/route.ts',
      'auth/[...all]/route.ts',
      'copilotkit/[[...slug]]/route.ts',
    ]);
  });

  it('installs no Mastra server, deployer or CLI', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      names.filter((name) => /^(mastra|@mastra\/(server|deployer.*|cli))$/.test(name)),
    ).toEqual([]);
    expect(Object.values(pkg.scripts).filter((script) => /\bmastra\b/.test(script))).toEqual([]);
  });
});

// TEN-012: only info and agent run, connect and stop reach a handler.
describe('CopilotKit route guard (TEN-012)', () => {
  it('lets the served routes through', () => {
    for (const method of SERVED_COPILOT_ROUTES) {
      const route = { method, agentId: 'melos', threadId: 't' } as never;
      expect(() => allowServedRoutesOnly({ route })).not.toThrow();
    }
  });

  it('answers 404 for every other route, agent/suggest included', () => {
    for (const method of ['agent/suggest', 'threads/list', 'threads/clear', 'memories/list']) {
      try {
        allowServedRoutesOnly({ route: { method, agentId: 'melos' } as never });
        expect.unreachable(method);
      } catch (thrown) {
        expect((thrown as Response).status).toBe(404);
      }
    }
  });
});
