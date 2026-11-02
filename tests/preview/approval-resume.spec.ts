import { expect, test } from '@playwright/test';

// TEN-011 (U-25), run by hand against a preview deploy backed by Turso:
//   PLAYWRIGHT_BASE_URL=https://… MELOS_DEMO_PASSWORD=… [VERCEL_AUTOMATION_BYPASS_SECRET=…] \
//   npx playwright test -c playwright.preview.config.ts approval-resume
// A real model asks to change a split, which suspends for approval (§7.4). The resume is a separate
// request sent after the suspending invocation has ended, so Mastra must load the suspended run
// from melos-agent-runtime: a missing snapshot gives no tool result at all. The answer is a
// decline, so the Northstar seed is never written; the approval rows are the only writes.

const base = (process.env.PLAYWRIGHT_BASE_URL ?? '').replace(/\/$/, '');
const password = process.env.MELOS_DEMO_PASSWORD ?? '';
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const ASK = "Change Alex Ramirez's writer split on Ocean Blue to 40%, with Jordan Taylor at 60%.";
let cookie = '';

type Interrupt = {
  id: string;
  toolCallId: string;
  metadata: { mastra: { toolName: string; suspendPayload: { inputHash: string } } };
};
type Event = {
  type: string;
  toolCallId?: string;
  content?: string;
  outcome?: { type: string; interrupts: Interrupt[] };
};

const headers = () => ({
  'content-type': 'application/json',
  origin: base,
  cookie,
  ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
});
/** Runs the agent once; returns its events and the Vercel request id of the invocation. */
async function run(threadId: string, extra: Record<string, unknown>) {
  const response = await fetch(`${base}/api/copilotkit/agent/melos/run`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      ...{ threadId, runId: crypto.randomUUID(), tools: [], context: [], state: {} },
      ...{ messages: [{ id: 'msg-ask', role: 'user', content: ASK }], forwardedProps: {} },
      ...extra,
    }),
  });
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Event);
  return { events, vercelId: response.headers.get('x-vercel-id') };
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

test('U-25: an approval suspended in one invocation resumes in another', async () => {
  const threadId = `preview-u25-${Date.now()}`;
  const suspended = await run(threadId, {});
  const finished = suspended.events.find(({ type }) => type === 'RUN_FINISHED');
  expect(finished?.outcome?.type, 'the model asked for a write').toBe('interrupt');
  const [interrupt] = finished?.outcome?.interrupts ?? [];
  expect(interrupt.metadata.mastra.toolName).toBe('updateWriterShares');
  // The suspended tool call reaches the chat before the interrupt (melos-qlw.10).
  expect(
    suspended.events.some(
      (e) => e.type === 'TOOL_CALL_START' && e.toolCallId === interrupt.toolCallId,
    ),
  ).toBe(true);

  // Long enough for the suspending invocation to end; Vercel picks the instance for the resume.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const decision = {
    approved: false,
    inputHash: interrupt.metadata.mastra.suspendPayload.inputHash,
  };
  const resumed = await run(threadId, {
    resume: [{ interruptId: interrupt.id, status: 'resolved', payload: decision }],
  });
  const result = resumed.events.find(
    (e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === interrupt.toolCallId,
  );
  expect(JSON.parse(result?.content ?? 'null'), 'the resume found the suspended run').toEqual({
    status: 'error',
    error: { code: 'DECLINED', reason: 'declined' },
  });
  expect(resumed.events.map(({ type }) => type)).toContain('RUN_FINISHED');
  console.log(`suspended in ${suspended.vercelId}; resumed in ${resumed.vercelId}`);
});
