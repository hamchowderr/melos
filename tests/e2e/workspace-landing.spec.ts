import { expect, test } from '@playwright/test';
import { signIn, signUp } from './support';

const START_PAGES = [
  ['Songwriter or Artist', '/catalog'],
  ['Producer or Co-Writer', '/catalog'],
  ['Sync Licensing Agent', '/today'],
  ['Independent Label', '/catalog'],
  ['Artist Manager', '/today'],
] as const;

for (const [label, path] of START_PAGES) {
  test(`ONB-E2E-005: a new ${label} workspace opens ${path}`, async ({ page }) => {
    await signIn(page, await signUp(page, 'Landing'));
    const name = `Landing ${Date.now()}`;
    await page.getByLabel('Workspace Name').fill(name);
    await page.getByRole('radio', { name: label }).check();
    await page.getByRole('button', { name: 'Create Workspace' }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 60_000 });
    await expect(page.getByTestId('active-workspace-name')).toHaveText(name);
  });
}
