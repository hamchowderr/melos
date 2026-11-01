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
  const grid = page.getByRole('region', { name: 'Song search results' });
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
  await expect(card.getByTestId('readiness')).toContainText('Not one-stop ready');
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
  const card = page.getByRole('region', { name: 'Rights readiness' });
  const row = card.getByRole('row', { name: 'Harbor Lights readiness' });
  await expect(row).toContainText('1 blocking');
  await expect(row).toContainText('1 warning');
});

test('TST-AI-003: AGUIMock drives the ownership proposal', async ({ page }) => {
  await ask(page, 'agui proposal');
  const card = page.getByRole('region', { name: 'Proposed ownership' });
  await expect(
    card.getByRole('list', { name: 'Proposed shares' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect(card.getByRole('list', { name: 'Not proposed' })).toHaveText(
    'Master has no own party set in Settings.',
  );
});

test('TST-AI-003: a refusal renders a plain sentence, not a card', async ({ page }) => {
  await ask(page, 'agui not found');
  const alert = page.locator('[data-error-code="NOT_FOUND"]');
  await expect(alert).toHaveText('That item is not in this workspace.');
  await expect(page.getByRole('region', { name: 'Song', exact: true })).toHaveCount(0);
});
