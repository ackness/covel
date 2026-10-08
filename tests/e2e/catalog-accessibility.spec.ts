import { test, expect } from "@playwright/test";

test("catalog controls support native keyboard, labels, and the panel inert boundary", async ({
  page,
  baseURL,
}) => {
  // This synthetic fixture needs only Vite modules, never API/provider calls.
  const origin = new URL(baseURL!).origin;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin && !url.pathname.startsWith("/api/")
      ? route.continue()
      : route.abort();
  });
  await page.goto(
    "/src/lib/catalog/__tests__/interactive-accessibility.browser.html",
  );
  const first = page.getByRole("switch", { name: "Switch first", exact: true });
  const second = page.getByRole("switch", {
    name: "Switch second",
    exact: true,
  });
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("type", "button");
  await page
    .getByRole("button", { name: "Toggle panel lock", exact: true })
    .focus();
  for (const name of [
    "Input first",
    "Textarea first",
    "Select first",
    "Switch first",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(name, { exact: true })).toBeFocused();
  }
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(second).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("form")).toHaveAttribute("data-submitted", "false");

  for (const name of [
    "Input first",
    "Textarea first",
    "Select first",
    "Input second",
    "Textarea second",
    "Select second",
  ]) {
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByLabel(name, { exact: true })).toBeFocused();
  }
  const controls = page.locator(
    'input, textarea, select, button[role="switch"]',
  );
  const ids = await controls.evaluateAll((elements) =>
    elements.map((element) => element.id),
  );
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(8);
  await page.getByLabel("Input first", { exact: true }).fill("edited");
  await expect(page.getByLabel("Textarea first", { exact: true })).toHaveValue(
    "edited",
  );
  await expect(page.getByLabel("Input second", { exact: true })).toHaveValue(
    "initial",
  );

  await page
    .getByRole("button", { name: "Toggle panel lock", exact: true })
    .click();
  await expect(first.locator("xpath=ancestor::*[@inert]")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "After panel", exact: true }),
  ).toBeFocused();
  // A forced DOM focus is also rejected by the browser, not by a test mock.
  for (const control of await controls.all()) {
    await control.evaluate((element) => (element as HTMLElement).focus());
    await expect(control).not.toBeFocused();
  }
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(first).toHaveAttribute("aria-checked", "false");

  await page
    .getByRole("button", { name: "Toggle panel lock", exact: true })
    .click();
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-checked", "true");
});
