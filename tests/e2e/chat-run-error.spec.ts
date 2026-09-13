import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from './support';

const PROMPT = 'simulate a provider credits error';

// fixtures/aimock/provider-error.json: the first model call is a 402, the next one answers.
test('a provider error shows a plain-language message with a working retry', async ({ page }) => {
  const workspaceName = await signUpWithWorkspace(page, 'Error');
  await expect(page.getByTestId('active-workspace-name')).toHaveText(workspaceName);

  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill(PROMPT);
  await input.press('Enter');

  const notice = page.getByTestId('chat-run-error');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveAttribute('data-error-kind', 'credits');
  await expect(notice).toContainText('out of credits');
  await expect(notice).not.toContainText('Insufficient credits');
  await page.screenshot({ path: 'test-results/chat-run-error.png', fullPage: true });

  await notice.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Recovered. The provider answered on retry.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(notice).toBeHidden();
  await expect(page.getByText(PROMPT, { exact: true })).toHaveCount(1);
});
