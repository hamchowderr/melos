import { rmSync } from 'node:fs';
import { LLMock } from '@copilotkit/aimock';

export const BASE_URL = 'http://localhost:3100';

type Handler = (request: Request) => Promise<Response> | Response;

/**
 * Starts an in-process AIMock and gives this test file its own fresh libSQL files. Call it
 * before importing any app module: the env is read once, when those modules load.
 */
export async function prepareTestEnvironment(name: string): Promise<LLMock> {
  const mock = new LLMock({ port: 0 });
  mock.loadFixtureDir('fixtures/aimock');
  const url = await mock.start();
  process.env.MELOS_LLM_BASE_URL = `${url.replace(/\/$/, '')}/v1`;

  const control = `data/test-${name}-control.db`;
  const agent = `data/test-${name}-agent.db`;
  for (const file of [control, agent]) {
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
  }
  process.env.MELOS_CONTROL_DATABASE_URL = `file:./${control}`;
  process.env.MELOS_AGENT_DATABASE_URL = `file:./${agent}`;

  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { controlDb } = await import('../../src/server/db/client');
  await migrate(controlDb, { migrationsFolder: './src/server/db/migrations' });
  return mock;
}

/** A browser-like client for route handlers: keeps cookies across calls. */
export class TestClient {
  cookie = '';

  async call(handler: Handler, method: string, path: string, body?: unknown): Promise<Response> {
    const response = await handler(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          origin: BASE_URL,
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    this.store(response.headers.getSetCookie());
    return response;
  }

  headers(): Headers {
    return new Headers(this.cookie ? { cookie: this.cookie } : {});
  }

  private store(setCookies: string[]): void {
    if (setCookies.length === 0) return;
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => pair.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    for (const setCookie of setCookies) {
      const [pair = ''] = setCookie.split(';');
      const [name = '', value = ''] = pair.split(/=(.*)/s);
      jar.set(name, value);
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

type AgUiEvent = { type: string; content?: string; toolCallName?: string; message?: string };

/** Parses the AG-UI server-sent event stream returned by the CopilotKit runtime. */
export async function readAgUiEvents(response: Response): Promise<AgUiEvent[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as AgUiEvent);
}
