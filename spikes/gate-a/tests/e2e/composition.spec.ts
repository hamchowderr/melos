import { expect, test } from "@playwright/test";

test("CopilotKit renders CompositionCard for the getComposition tool result", async ({ page, baseURL }) => {
  const stamp = Date.now();
  const headers = { origin: baseURL ?? "http://localhost:3100" };

  // page.request shares the browser context's cookie jar, so the page is signed in.
  const signUp = await page.request.post("/api/auth/sign-up/email", {
    headers,
    data: { email: `e2e-${stamp}@example.test`, password: "gate-a-password-123", name: "E2E" },
  });
  expect(signUp.ok()).toBeTruthy();

  const created = await page.request.post("/api/auth/organization/create", {
    headers,
    data: { name: "Midnight Records", slug: `midnight-records-${stamp}` },
  });
  expect(created.ok()).toBeTruthy();
  const { id: organizationId } = (await created.json()) as { id: string };

  const active = await page.request.post("/api/auth/organization/set-active", {
    headers,
    data: { organizationId },
  });
  expect(active.ok()).toBeTruthy();

  await page.goto("/");
  const input = page.getByRole("textbox").first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill("Show me Midnight Drive");
  await input.press("Enter");

  const card = page.getByTestId("composition-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("composition-title")).toHaveText("Midnight Drive");
  await expect(page.getByTestId("composition-org")).toContainText(organizationId);
  await page.screenshot({ path: "test-results/composition-card.png", fullPage: true });
});
