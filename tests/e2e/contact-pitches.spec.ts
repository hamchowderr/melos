import { expect, type Page, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.19: contact pitch history and Create pitch, and "Who Hasn't Heard This" (EXPECTED DEMO-005).

async function openPerson(page: Page, name: string) {
  await signInAsJordan(page);
  await page.goto('/people');
  await page.getByRole('link', { name, exact: true }).first().click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

test('CRM-E2E-001: a contact shows its pitches and messages, and Create pitch adds a draft', async ({
  page,
}) => {
  await openPerson(page, 'Rebecca Carter');
  const history = page.getByRole('region', { name: 'Pitch History' });
  await expect(
    history.getByRole('row', { name: 'Paper Planes at 2AM', exact: true }),
  ).toContainText('Awaiting reply');
  await expect(history.getByRole('list', { name: 'Recent Messages' })).toContainText(
    'Paper Planes at 2AM: one-stop track for sync',
  );

  // The one write: Theo has never heard Neon Static, which no EXPECTED row reads (DEMO-005 is Home Again).
  await openPerson(page, 'Theo Grant');
  const theo = page.getByRole('region', { name: 'Pitch History' });
  await expect(theo.getByRole('row', { name: 'Neon Static', exact: true })).toHaveCount(0);
  await theo
    .getByRole('combobox', { name: 'Song to Pitch' })
    .selectOption({ label: 'Neon Static' });
  await theo.getByRole('button', { name: 'Create Pitch' }).click();
  await expect(theo.getByRole('row', { name: 'Neon Static', exact: true })).toContainText('Draft');
});

test("CRM-E2E-006: a song page lists who hasn't heard it", async ({ page }) => {
  await signInAsJordan(page);
  await page.goto('/catalog');
  await page.getByRole('link', { name: 'Home Again' }).first().click();
  const heard = page.getByRole('region', { name: "Who Hasn't Heard This" });
  await expect(
    heard.getByRole('list', { name: 'Planned, not contacted' }).getByRole('listitem'),
  ).toHaveText(['Maya Chen', 'Theo Grant']);
  await expect(heard.getByRole('list', { name: 'Never Pitched' }).getByRole('listitem')).toHaveText(
    ['Rebecca Carter', 'Malik Johnson'],
  );
});
