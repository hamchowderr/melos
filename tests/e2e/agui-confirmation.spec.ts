import { readFileSync } from 'node:fs';
import { type AGUIEvent, AGUIMock, LLMock } from '@copilotkit/aimock';
import { expect, type Page, test } from '@playwright/test';

// TST-AI-003, ConfirmationCard (§7.4 steps 3 to 5): AGUIMock ends a run with the interrupt outcome
// @ag-ui/mastra emits for a suspended tool, then answers the resume run. No Mastra or database.
const PORT = 4022;
const AGENT_URL = `http://127.0.0.1:${PORT}/agui`;
const CALL_ID = 'tc_agui_approval';

type Fixture = {
  message: string;
  toolName: string;
  args: unknown;
  request: { inputHash: string };
  approvedResult: unknown;
  declinedResult: unknown;
};
const {
  fixtures: [fixture],
} = JSON.parse(readFileSync('fixtures/agui/confirmation.json', 'utf8')) as { fixtures: Fixture[] };

type Resume = {
  interruptId: string;
  status: string;
  payload: { approved: boolean; inputHash: string };
};
const resumes: Resume[] = [];
let server: LLMock;

const run = (inner: object[], outcome?: object) =>
  [
    { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
    ...inner,
    { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run', ...(outcome ? { outcome } : {}) },
  ] as AGUIEvent[];

const agui = new AGUIMock();

test.beforeAll(async () => {
  // Mounted on LLMock, which answers the browser's CORS preflight (as in agui-renderers.spec.ts).
  server = new LLMock({ port: PORT, host: '127.0.0.1' });
  server.mount('/agui', {
    handleRequest: (req, res, path) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return agui.handleRequest(req, res, path);
    },
  });
  await server.start();
});

test.afterAll(async () => {
  await server?.stop();
});

/** The run's tool result once the decision resumes it. */
const resumedRun = (approved: boolean) =>
  run([
    {
      ...{ type: 'TOOL_CALL_RESULT', toolCallId: CALL_ID, messageId: 'msg_result', role: 'tool' },
      content: JSON.stringify(approved ? fixture.approvedResult : fixture.declinedResult),
    },
  ]);

async function ask(page: Page, approved: boolean) {
  agui.reset();
  resumes.length = 0;
  // First match wins: a resume run records its answer and gets the result it leads to.
  agui.onPredicate((input) => {
    const resume = (input as { resume?: Resume[] }).resume;
    if (!resume?.length) return false;
    resumes.push(...resume);
    return true;
  }, resumedRun(approved));
  agui.onRun(fixture.message, suspendedRun());
  await page.goto(`/dev/agui?agent=${encodeURIComponent(AGENT_URL)}`);
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(fixture.message);
  await input.press('Enter');
  const card = page.getByRole('region', { name: 'Approve this change' });
  await expect(card).toContainText('Change the writer split on Harbor Lights');
  await expect(card.getByRole('list', { name: 'Before' })).toContainText(/Mock Writer.*50\.00%/);
  await expect(card.getByRole('list', { name: 'After' })).toContainText(/Mock Writer.*60\.00%/);
  return card;
}

function suspendedRun() {
  return run(
    [
      { type: 'TOOL_CALL_START', toolCallId: CALL_ID, toolCallName: fixture.toolName },
      { type: 'TOOL_CALL_ARGS', toolCallId: CALL_ID, delta: JSON.stringify(fixture.args) },
      { type: 'TOOL_CALL_END', toolCallId: CALL_ID },
    ],
    {
      type: 'interrupt',
      interrupts: [
        {
          id: `run::${CALL_ID}`,
          reason: 'mastra:tool_suspend',
          toolCallId: CALL_ID,
          metadata: {
            mastra: {
              type: 'mastra_suspend',
              toolName: fixture.toolName,
              suspendPayload: fixture.request,
              runId: 'run',
            },
          },
        },
      ],
    },
  );
}

test('TST-AI-003: Approve resumes with the inputHash and renders the RightsPanel', async ({
  page,
}) => {
  const card = await ask(page, true);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('region', { name: 'Rights' })).toBeVisible();
  expect(resumes).toEqual([
    {
      interruptId: `run::${CALL_ID}`,
      status: 'resolved',
      payload: { approved: true, inputHash: fixture.request.inputHash },
    },
  ]);
});

test('TST-AI-003: Decline resolves (never cancels) with approved false', async ({ page }) => {
  const card = await ask(page, false);
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText('Not approved, so nothing was changed.')).toBeVisible();
  expect(resumes).toEqual([
    {
      interruptId: `run::${CALL_ID}`,
      status: 'resolved',
      payload: { approved: false, inputHash: fixture.request.inputHash },
    },
  ]);
});
