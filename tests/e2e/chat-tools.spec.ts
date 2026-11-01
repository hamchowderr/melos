import { expect, type Page, test } from '@playwright/test';
import { signInAsJordan } from './support';

async function ask(page: Page, prompt: string) {
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill(prompt);
  await input.press('Enter');
}

// fixtures/aimock/read-sequences.json: searchMusic, then getMusicWorkspace, then a short answer.
test('melos-2xl.1: searchMusic renders its song grid from the full result (U-03)', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'show me midnight drive');

  const grid = page.getByRole('region', { name: 'Song search results' });
  await expect(grid).toBeVisible({ timeout: 60_000 });
  const song = grid.getByRole('listitem').filter({ hasText: 'Midnight Drive' });
  await expect(song.getByRole('link', { name: 'Midnight Drive' })).toHaveAttribute(
    'href',
    /^\/catalog\/compositions\//,
  );
  // The ISWC and readiness are not in the model summary (§3.6): the renderer got the full DTO.
  await expect(song).toContainText('ISWC T-900.000.001-0');
  await expect(song.getByTestId('readiness')).toContainText('One Stop Ready');
  await expect(page.getByText('Here is Midnight Drive.')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: 'test-results/chat-song-grid.png' });
});
