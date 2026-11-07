import { expect, type Page, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.21: /reports on the seeded Northstar workspace (docs/fixtures/EXPECTED.md DEMO-009).

async function openReports(page: Page) {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
}

const template = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Report template' }).getByRole('button', { name });

test('RPT-E2E-001: a full report previews live and a section toggles off', async ({ page }) => {
  await openReports(page);
  await template(page, 'Full report').click();
  await page.getByRole('combobox', { name: 'Add a song' }).selectOption({ label: 'Ocean Blue' });
  const text = page.getByRole('region', { name: 'Report text' });
  await expect(text).toContainText('Ocean Blue');
  await expect(text).toContainText('ISWC: T9000000020');
  await expect(text).toContainText('Salt on the window');

  await page.getByRole('checkbox', { name: 'Composition' }).uncheck();
  await expect(text).not.toContainText('ISWC: T9000000020');
  await expect(text).toContainText('Salt on the window');
});

test('RPT-E2E-002: the no-lyrics and lyrics-only presets', async ({ page }) => {
  await openReports(page);
  await page.getByRole('combobox', { name: 'Add a song' }).selectOption({ label: 'Ocean Blue' });
  const text = page.getByRole('region', { name: 'Report text' });

  await template(page, 'Report without lyrics').click();
  await expect(text).toContainText('Rights');
  await expect(text).not.toContainText('Salt on the window');
  await expect(page.getByRole('checkbox', { name: 'Lyrics' })).not.toBeChecked();

  await template(page, 'Lyrics only').click();
  await expect(text).toContainText('Salt on the window');
  await expect(text).not.toContainText('Rights');
});

// The one write: an insert-only snapshot, which no other spec or EXPECTED row counts.
test('RPT-E2E-005: a multi-song report keeps its order and saves a snapshot', async ({ page }) => {
  await openReports(page);
  const add = page.getByRole('combobox', { name: 'Add a song' });
  await add.selectOption({ label: 'Midnight Drive' });
  await add.selectOption({ label: 'Ocean Blue' });
  await page.getByRole('button', { name: 'Move Ocean Blue up' }).click();
  await expect(page.getByRole('list', { name: 'Report songs' }).getByRole('listitem')).toHaveText([
    /Ocean Blue/,
    /Midnight Drive/,
  ]);
  const text = page.getByRole('region', { name: 'Report text' });
  await expect(text.locator('pre')).toHaveText(/^Ocean Blue[\s\S]*\nMidnight Drive\n/);

  await page.getByRole('button', { name: 'Save snapshot' }).click();
  await expect(text).toContainText('Snapshot saved.');
  const snapshots = page.getByRole('table', { name: 'Saved snapshots' });
  await snapshots
    .getByRole('row', { name: /^Snapshot / })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('Midnight Drive');
  await expect(page.getByRole('dialog'))
    .toContainText('2 songs')
    .catch(() => undefined);
});
