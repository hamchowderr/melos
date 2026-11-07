import { readFileSync } from 'node:fs';
import { AGUIMock, LLMock } from '@copilotkit/aimock';
import { expect, type Page, test } from '@playwright/test';

// TST-AI-003 for the report tools (melos-ajt.16): AGUIMock streams fixed tool results from
// fixtures/agui/reports.json to ReportTemplateList and ReportPreview. Fixture data only.
const PORT = 4023;
const AGENT_URL = `http://127.0.0.1:${PORT}/agui`;

type Fixture = { message: string; toolName: string; args: unknown; result: unknown };
const { fixtures } = JSON.parse(readFileSync('fixtures/agui/reports.json', 'utf8')) as {
  fixtures: Fixture[];
};

let server: LLMock;

test.beforeAll(async () => {
  const agui = new AGUIMock();
  for (const { message, toolName, args, result } of fixtures)
    agui.onToolCall(message, toolName, JSON.stringify(args), { result: JSON.stringify(result) });
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

test('TST-AI-003: AGUIMock drives ReportTemplateList', async ({ page }) => {
  await ask(page, 'agui templates');
  const list = page.getByRole('region', { name: 'Report Templates' }).getByRole('list');
  await expect(list).toContainText('Fullpreset');
  await expect(list).toContainText('Sans lyrics');
});

test('TST-AI-003: AGUIMock drives ReportPreview, text first with copy', async ({ page }) => {
  await ask(page, 'agui report');
  const preview = page.getByRole('region', { name: 'Report Preview', exact: true });
  await expect(preview.getByRole('region', { name: 'Report Text' })).toContainText(
    'Writers: Mock Writer 100%',
  );
  await expect(preview).toContainText('1 song · core, rights');
  await expect(preview).not.toContainText('lyrics');
  await expect(preview.getByRole('button', { name: 'Copy Text' })).toBeVisible();
});

test('TST-AI-003: AGUIMock renders a generateReport snapshot', async ({ page }) => {
  await ask(page, 'agui saved report');
  const saved = page.getByRole('region', { name: 'Saved Report', exact: true });
  await expect(saved).toContainText('saved 2026-09-10');
});
