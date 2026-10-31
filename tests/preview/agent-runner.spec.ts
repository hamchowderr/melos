import { expect, test } from '@playwright/test';

// Run by hand against a preview deploy backed by Turso (melos-jcf.9, U-23, U-24, U-30):
//   PLAYWRIGHT_BASE_URL=https://… MELOS_DEMO_PASSWORD=… [VERCEL_AUTOMATION_BYPASS_SECRET=…] \
//   npx playwright test -c playwright.preview.config.ts agent-runner
// It signs in as Jordan (Northstar seed) and drives the CopilotKit route with fetch, so a request
// can be dropped mid-stream. A real model answers; nothing is written outside the agent runtime.

const base = (process.env.PLAYWRIGHT_BASE_URL ?? '').replace(/\/$/, '');
const password = process.env.MELOS_DEMO_PASSWORD ?? '';
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const LONG = 'Write about 400 words on how a sync licensing pitch usually unfolds, step by step.';
let cookie = '';

const headers = () => ({
  'content-type': 'application/json',
  origin: base,
  cookie,
  ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
});
const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}/api/copilotkit${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
const runBody = (threadId: string, text: string) => ({
  threadId,
  runId: crypto.randomUUID(),
  messages: [{ id: crypto.randomUUID(), role: 'user', content: text }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});
const eventsOf = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as { type: string; name?: string });
const connect = async (threadId: string) =>
  eventsOf(await (await post('/agent/melos/connect', runBody(threadId, ''))).text());

/** Reads a run's stream until its first text delta, then drops the request (a client disconnect). */
async function startAndDrop(threadId: string, text: string) {
  const controller = new AbortController();
  const response = await post('/agent/melos/run', runBody(threadId, text), controller.signal);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  let seen = '';
  while (reader && !seen.includes('TEXT_MESSAGE_CONTENT')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  controller.abort();
}

test.beforeAll(async () => {
  expect(base, 'PLAYWRIGHT_BASE_URL').not.toBe('');
  expect(password, 'MELOS_DEMO_PASSWORD').not.toBe('');
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email: 'jordan@silverline.example', password }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
});

test('U-30: a run keeps going and is stored after the client disconnects', async () => {
  const threadId = `preview-u30-${Date.now()}`;
  await startAndDrop(threadId, LONG);
  // after() keeps the invocation alive; the finished run then replays from melos-agent-runtime.
  await expect
    .poll(async () => (await connect(threadId)).some((e) => e.type === 'RUN_FINISHED'), {
      timeout: 90_000,
      intervals: [2_000],
    })
    .toBe(true);
});

test('U-23: a connect while the run is live replays it once it finishes', async () => {
  const threadId = `preview-u23-${Date.now()}`;
  await startAndDrop(threadId, LONG);
  const events = await connect(threadId);
  const types = events.map(({ type }) => type);
  // Same instance: the live tail. Another instance: polling, or melos.run_pending near maxDuration.
  const pending = events.some((e) => e.type === 'CUSTOM' && e.name === 'melos.run_pending');
  expect(pending || types.includes('RUN_FINISHED')).toBe(true);
  expect(types).toContain('TEXT_MESSAGE_CONTENT');
});

test('U-24: stop ends a live run from a separate request within the polling interval', async () => {
  const threadId = `preview-u24-${Date.now()}`;
  await startAndDrop(threadId, LONG);
  const stopped = await post(`/agent/melos/stop/${threadId}`, {});
  expect(await stopped.json()).toMatchObject({ stopped: true });
  const started = Date.now();
  await expect
    .poll(
      async () =>
        (await connect(threadId)).some((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR'),
      {
        timeout: 15_000,
        intervals: [500],
      },
    )
    .toBe(true);
  console.log(`stop settled in ${Date.now() - started} ms`);
});
