import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

// The first auth request after `next start` hashes a password on a cold server; 5s is too tight.
export const AUTH_REDIRECT = { timeout: 30_000 };

export type TestUser = { email: string; password: string };

/** Signs up a fresh user and waits for the sign-in page. */
export async function signUp(page: Page, label: string): Promise<TestUser> {
  const stamp = Date.now();
  const email = `${label.toLowerCase()}-${stamp}@example.test`;
  const password = `${label.toLowerCase()}-password-123`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(`${label} Test`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/sign-in$/, AUTH_REDIRECT);
  return { email, password };
}

/** Signs in from the sign-in page as a user with no active workspace. */
export async function signIn(page: Page, { email, password }: TestUser): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/workspaces\/new$/, AUTH_REDIRECT);
}

/** Signs up a fresh user, signs in and creates a workspace. Returns the workspace name. */
export async function signUpWithWorkspace(page: Page, label: string): Promise<string> {
  await signIn(page, await signUp(page, label));
  const workspaceName = `${label} Records ${Date.now()}`;

  await createWorkspace(page, workspaceName);
  return workspaceName;
}

/** On /workspaces/new: creates a workspace, which becomes the active one, and opens it. */
export async function createWorkspace(page: Page, workspaceName: string): Promise<void> {
  await page.getByLabel('Workspace name').fill(workspaceName);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}/`, AUTH_REDIRECT);
  await expect(page.getByTestId('active-workspace-name')).toHaveText(workspaceName);
}

/** The active organization id of the browser's session. */
export async function activeOrganizationId(page: Page): Promise<string> {
  const { session } = await (await page.request.get('/api/auth/get-session')).json();
  expect(session.activeOrganizationId).toBeTruthy();
  return session.activeOrganizationId;
}

/** Sends "ping" (fixtures/aimock/ping.json) and waits for the ping tool's card. */
export async function pingInChat(page: Page): Promise<void> {
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill('ping');
  await input.press('Enter');
  await expect(page.getByTestId('ping-card')).toBeVisible({ timeout: 60_000 });
}

/** The link in the newest auth email of this kind to this address, from the development outbox. */
export function readOutboxLink(kind: 'verify-email' | 'invitation', to: string): string {
  const dir = '.data/auth-outbox';
  for (const file of readdirSync(dir).sort().reverse()) {
    const email = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    if (email.kind === kind && email.to === to) return email.link;
  }
  throw new Error(`No ${kind} email to ${to} in ${dir}`);
}
