import { readFileSync } from 'node:fs';
import { AGUIMock, LLMock } from '@copilotkit/aimock';
import { expect, type Page, test } from '@playwright/test';

// TST-AI-003: AGUIMock streams fixed AG-UI tool-call events straight to the chat's renderers.
// No Mastra, model or workspace database runs, and the data is fixture-only (Harbor Lights).
const PORT = 4021;
const AGENT_URL = `http://127.0.0.1:${PORT}/agui`;

type Fixture = { message: string; toolName: string; args: unknown; result: unknown };
const { fixtures } = JSON.parse(readFileSync('fixtures/agui/renderers.json', 'utf8')) as {
  fixtures: Fixture[];
};

let server: LLMock;

test.beforeAll(async () => {
  const agui = new AGUIMock();
  for (const { message, toolName, args, result } of fixtures) {
    agui.onToolCall(message, toolName, JSON.stringify(args), { result: JSON.stringify(result) });
  }
  // Mounted on LLMock, which answers the browser's CORS preflight. A mounted handler's own
  // response carries no CORS header, so the wrapper adds it before AGUIMock writes.
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

async function ask(page: Page, prompt: string) {
  await page.goto(`/dev/agui?agent=${encodeURIComponent(AGENT_URL)}`);
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(prompt);
  await input.press('Enter');
}

test('TST-AI-003: AGUIMock drives the song grid', async ({ page }) => {
  await ask(page, 'agui search');
  const grid = page.getByRole('region', { name: 'Song Search Results' });
  await expect(grid.getByRole('link', { name: 'Harbor Lights' })).toBeVisible();
  await expect(grid).toContainText('Mock Artist · ISWC T-900.000.099-0');
});

test('TST-AI-003: AGUIMock drives MusicWorkspaceCard', async ({ page }) => {
  await ask(page, 'agui song card');
  const card = page.getByRole('region', { name: 'Song', exact: true });
  await expect(card).toContainText('Harbor Lights');
  await expect(card).toContainText('Mock Writer 100.00%');
  await expect(card).toContainText('2 pitched');
  await expect(card.getByRole('list', { name: 'Recordings' })).toContainText('US-DMO-26-00099');
  await expect(card.getByTestId('readiness')).toContainText('Not One Stop Ready');
});

test('TST-AI-003: AGUIMock drives RightsPanel', async ({ page }) => {
  await ask(page, 'agui rights');
  const rights = page.getByRole('region', { name: 'Rights' });
  await expect(rights.getByRole('table', { name: 'Writers' }).getByRole('row')).toContainText([
    'Holder',
    /Mock Writer.*Songwriter, Composer.*60\.00%/,
    /Second Writer.*Lyricist.*40\.00%/,
    /Total.*100\.00%/,
  ]);
  await expect(
    rights.getByRole('table', { name: 'Publishing WORLD' }).getByTestId('share-total'),
  ).toHaveText('75.00%');
  await expect(rights.getByRole('list', { name: 'Issues' })).toContainText(
    'PUBLISHING_TOTAL_INCOMPLETE',
  );
});

test('TST-AI-003: AGUIMock drives the readiness checklist', async ({ page }) => {
  await ask(page, 'agui readiness');
  const card = page.getByRole('region', { name: 'Rights Readiness' });
  const row = card.getByRole('row', { name: 'Harbor Lights readiness' });
  await expect(row).toContainText('1 blocking');
  await expect(row).toContainText('1 warning');
});

test('TST-AI-003: AGUIMock drives the ownership proposal', async ({ page }) => {
  await ask(page, 'agui proposal');
  const card = page.getByRole('region', { name: 'Proposed Ownership' });
  await expect(
    card.getByRole('list', { name: 'Proposed Shares' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect(card.getByRole('list', { name: 'Not Proposed' })).toHaveText(
    'Master has no own party set in Settings.',
  );
});

test('TST-AI-003: AGUIMock drives PitchTable', async ({ page }) => {
  await ask(page, 'agui pitches');
  const table = page.getByRole('region', { name: 'Pitches', exact: true });
  await expect(table.getByRole('list', { name: 'Pitch List' })).toContainText(
    'Harbor Lights to Mock SupervisorAwaiting reply · follow-up due',
  );
});

test('TST-AI-003: AGUIMock drives PitchCard and PitchTimeline', async ({ page }) => {
  await ask(page, 'agui pitch');
  const card = page.getByRole('region', { name: 'Pitch', exact: true });
  await expect(card).toContainText('Mock Supervisor');
  await expect(card.getByRole('list', { name: 'Songs in This Pitch' })).toContainText(
    'Harbor LightsAwaiting reply · follow-up due',
  );
  const timeline = card.getByRole('list', { name: 'Timeline' });
  await expect(timeline.locator('li').first()).toContainText(
    '2026-09-03Sent: Harbor Lights for your show',
  );
  await expect(timeline.locator('li').nth(1)).toContainText(
    'status changed · Pitched to Awaiting reply',
  );
});

test('TST-AI-003: AGUIMock drives the getMessageThread PitchTimeline', async ({ page }) => {
  await ask(page, 'agui thread');
  const timeline = page
    .getByRole('region', { name: 'Messages', exact: true })
    .getByRole('list', { name: 'Timeline' });
  await expect(timeline.locator('li').first()).toContainText(
    'Sent: Harbor Lights for your showHi, here is Harbor Lights.',
  );
  await expect(timeline.locator('li').nth(1)).toContainText(
    '2026-09-05Reply: Re: Harbor Lights for your showLove it, send stems.',
  );
});

test('TST-AI-003: AGUIMock drives ContactGrid', async ({ page }) => {
  await ask(page, 'agui contacts');
  const grid = page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(grid.getByRole('link', { name: 'Mock Supervisor' })).toBeVisible();
  await expect(grid).toContainText('Mock Sync Co · music supervisor · supervisor@mock.example');
  await expect(grid).toContainText('1 open pitch');
});

test('TST-AI-003: AGUIMock drives ContactCard', async ({ page }) => {
  await ask(page, 'agui contact card');
  const card = page.getByRole('region', { name: 'Contact', exact: true });
  await expect(card).toContainText('Mock Supervisor');
  await expect(card.getByRole('list', { name: 'Pitched Songs' })).toContainText(
    'Harbor LightsAwaiting reply · follow-up due',
  );
  await expect(card.getByRole('list', { name: 'Recent Messages' })).toContainText(
    '2026-09-03 to them Harbor Lights for your show',
  );
});

test('TST-AI-003: AGUIMock drives the eligibility ContactGrid', async ({ page }) => {
  await ask(page, 'agui eligibility');
  const grid = page.getByRole('region', { name: "Who Hasn't Heard Harbor Lights", exact: true });
  await expect(grid.getByRole('list', { name: 'Planned, not contacted' })).toContainText(
    "Mock Supervisormusic supervisor · Hasn't heard",
  );
  await expect(grid.getByRole('list', { name: 'Never Pitched' })).toContainText(
    'Mock Agentlicensing agent',
  );
});

test('TST-AI-003: AGUIMock drives TodayWorkspace with FollowUpQueue', async ({ page }) => {
  await ask(page, 'agui today');
  const today = page.getByRole('region', { name: 'Today, 2026-09-10', exact: true });
  await expect(today.getByRole('list', { name: 'Follow-up queue' })).toContainText(
    'Harbor Lights to Mock SupervisorAwaiting reply · follow-up due',
  );
  await expect(today.getByRole('list', { name: 'Recent Replies' })).toContainText(
    'Mock Agent on Tidewater2026-09-09',
  );
  await expect(today.getByRole('list', { name: 'Ready to Pitch' })).toContainText(
    'Harbor Lights2 licensing agents have not heard it',
  );
  await expect(today).toContainText('1 recording is not ready to license.');
});

test('TST-AI-003: AGUIMock renders createPitch as its PitchCard', async ({ page }) => {
  await ask(page, 'agui create pitch');
  const card = page.getByRole('region', { name: 'Pitch', exact: true });
  await expect(card.getByRole('list', { name: 'Songs in This Pitch' })).toContainText(
    'Harbor LightsDraft',
  );
});

test('TST-AI-003: AGUIMock drives MessageDraftCard', async ({ page }) => {
  await ask(page, 'agui draft');
  const card = page.getByRole('region', { name: 'Email draft', exact: true });
  await expect(card).toContainText('To supervisor@mock.example');
  await expect(card.getByRole('textbox', { name: 'Subject' })).toHaveValue(
    'Harbor Lights, following up',
  );
  await expect(card.getByRole('textbox', { name: 'Body' })).toHaveValue(
    'Checking in on Harbor Lights.',
  );
  await expect(card.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await card.getByRole('textbox', { name: 'Subject' }).fill('Harbor Lights, one more time');
  await expect(card.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await expect(card.getByRole('complementary', { name: 'Drafted from' })).toContainText(
    'Harbor Lights · https://example.com/harbor',
  );
});

test('TST-AI-003: a refusal renders a plain sentence, not a card', async ({ page }) => {
  await ask(page, 'agui not found');
  const alert = page.locator('[data-error-code="NOT_FOUND"]');
  await expect(alert).toHaveText('That item is not in this workspace.');
  await expect(page.getByRole('region', { name: 'Song', exact: true })).toHaveCount(0);
});
