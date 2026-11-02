import { createClient } from '@libsql/client';
import { expect, type Page, test } from '@playwright/test';
import {
  activeOrganizationId,
  activeWorkspaceId,
  insertWorkspaceRows,
  signUpWithWorkspace,
} from './support';

// WRITE-VS-001 (SA Gate D, DEMO-008): "change Alex's split on Ocean Blue to 40%" through the real
// chat, Mastra agent and AIMock (fixtures/aimock/rights-mutation.json). The song is inserted with
// the Northstar ids into a fresh workspace (D-9), so the seeded catalog is never written.
const OCEAN = 'cmp_01KZ6VHB70P86KNP74MTYDF2XS';
const JORDAN = 'pty_01KZ45Y2Z0DBP6RW0QS8TZEBZZ';
const ALEX = 'pty_01KZ45Y4XGBPYNG8V581J15TRC';

async function addOceanBlue(page: Page) {
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const person = (id: string, display_name: string) => ({
    id,
    party_kind: 'person',
    display_name,
    ...stamps,
  });
  const writer = (id: string, party_id: string) => ({
    id,
    composition_id: OCEAN,
    party_id,
    writer_share_bp: 5000,
    ...stamps,
  });
  await insertWorkspaceRows(page, {
    parties: [person(JORDAN, 'Jordan Taylor'), person(ALEX, 'Alex Ramirez')],
    compositions: [{ id: OCEAN, title: 'Ocean Blue', ...stamps }],
    composition_contributors: [writer('ctr_WVS_JORDAN', JORDAN), writer('ctr_WVS_ALEX', ALEX)],
    composition_contributor_roles: [
      { contributor_id: 'ctr_WVS_JORDAN', role: 'songwriter' },
      { contributor_id: 'ctr_WVS_ALEX', role: 'songwriter' },
    ],
  });
}

/** Runs one read on the browser's active workspace database. */
async function workspaceRows(page: Page, sql: string) {
  const workspaceId = await activeWorkspaceId(await activeOrganizationId(page));
  const client = createClient({
    url: `file:./data/e2e-workspaces/melos-ws-${workspaceId.slice('ws_'.length)}.db`,
  });
  try {
    return (await client.execute(sql)).rows.map((row) => ({ ...row }));
  } finally {
    client.close();
  }
}
const writerShares = (page: Page) =>
  workspaceRows(
    page,
    `SELECT party_id, writer_share_bp FROM composition_contributors WHERE composition_id = '${OCEAN}' ORDER BY party_id`,
  );

async function ask(page: Page, prompt: string) {
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill(prompt);
  await input.press('Enter');
}

test('WRITE-VS-001: the DEMO-008 split waits for approval, then saves and audits', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'WriteVs');
  await addOceanBlue(page);
  await ask(page, 'change alex split on ocean blue to 40%');

  const card = page.getByRole('region', { name: 'Approve this change' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('list', { name: 'Before' })).toContainText(/Alex Ramirez.*50\.00%/);
  await expect(card.getByRole('list', { name: 'After' })).toContainText(/Alex Ramirez.*40\.00%/);
  await expect(card.getByRole('list', { name: 'After' })).toContainText(/Jordan Taylor.*60\.00%/);
  await expect(page.getByText('Waiting for your approval...')).toBeVisible();
  // No mutation before approval.
  expect(await writerShares(page)).toEqual(
    [
      { party_id: JORDAN, writer_share_bp: 5000 },
      { party_id: ALEX, writer_share_bp: 5000 },
    ].sort((a, b) => a.party_id.localeCompare(b.party_id)),
  );
  await page.screenshot({ path: 'test-results/write-vs-confirmation.png' });

  await card.getByRole('button', { name: 'Approve' }).click();
  // The approved call's RightsPanel follows the one getRightsSummary showed first.
  const writers = page
    .getByRole('region', { name: 'Rights' })
    .nth(1)
    .getByRole('table', { name: 'Writers' });
  await expect(writers.getByRole('row')).toContainText(
    [/Holder/, /Alex Ramirez.*40\.00%/, /Jordan Taylor.*60\.00%/, /Total.*100\.00%/],
    { timeout: 60_000 },
  );
  await expect(page.getByText('Done: Alex Ramirez now holds 40% of Ocean Blue.')).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: 'test-results/write-vs-approved.png' });

  expect(await writerShares(page)).toEqual(
    [
      { party_id: JORDAN, writer_share_bp: 6000 },
      { party_id: ALEX, writer_share_bp: 4000 },
    ].sort((a, b) => a.party_id.localeCompare(b.party_id)),
  );
  const audit = await workspaceRows(
    page,
    'SELECT action, actor_type, approval_tool_call_id FROM audit_log WHERE approval_tool_call_id IS NOT NULL ORDER BY id',
  );
  expect(audit.map(({ action }) => action)).toEqual([
    'approval.requested',
    'writer_shares.replace',
    'approval.granted',
  ]);
  expect(new Set(audit.map(({ approval_tool_call_id: id }) => id)).size).toBe(1);
  expect(audit.every(({ actor_type: actor }) => actor === 'agent')).toBe(true);
});

test('WRITE-VS-001: Ocean Blue from another workspace is NOT_FOUND', async ({ page }) => {
  await signUpWithWorkspace(page, 'WriteVsOther');
  await ask(page, 'who owns ocean blue');
  await expect(page.getByText('That item is not in this workspace.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('region', { name: 'Rights' })).toHaveCount(0);
});
