import { expect, type Page, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.20: /outreach writes stay on Malik's Neon Static pitch, which no EXPECTED row reads.

async function newDraft(page: Page, subject: string) {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Outreach' })
    .click();
  await expect(page.getByRole('heading', { name: 'Outreach' })).toBeVisible();
  await page.getByRole('button', { name: 'New draft' }).click();
  const sheet = page.getByRole('dialog');
  const pitch = sheet.getByRole('combobox', { name: 'Pitch' });
  const value = await pitch
    .locator('option', { hasText: /^Malik Johnson: Neon Static/ })
    .getAttribute('value');
  await pitch.selectOption(value ?? '');
  await sheet.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await sheet.getByRole('textbox', { name: 'Body' }).fill('Checking in on Neon Static.');
  await sheet.getByRole('button', { name: 'Create draft' }).click();
  const row = page.getByRole('row', { name: `${subject} to Malik Johnson` });
  await expect(row).toContainText('Draft');
  return row;
}

test('OUT-E2E-001: a draft is created from a pitch and its edits are saved', async ({ page }) => {
  const row = await newDraft(page, `Neon Static follow-up ${Date.now()}`);
  await row.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('combobox', { name: 'To' })).toContainText('Malik Johnson <');
  await sheet.getByRole('textbox', { name: 'Subject' }).fill('Neon Static, one more listen');
  await sheet.getByRole('button', { name: 'Save draft' }).click();
  await expect(sheet).toContainText('Draft saved.');
  await page.keyboard.press('Escape');
  await page.reload();
  await page
    .getByRole('row', { name: 'Neon Static, one more listen to Malik Johnson' })
    .first()
    .click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Subject' })).toHaveValue(
    'Neon Static, one more listen',
  );
});

test('OUT-E2E-002: sending asks to confirm and goes through the sandbox', async ({ page }) => {
  const subject = `Neon Static send ${Date.now()}`;
  const row = await newDraft(page, subject);
  await row.click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Send…' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(`Send "${subject}"?`);
  await confirm.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Sent.');
  await expect(row).toContainText('Sent');
  await row.click();
  await expect(page.getByRole('dialog')).toContainText('Checking in on Neon Static.');
});
