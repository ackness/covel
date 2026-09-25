import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

for (const width of [1280, 390]) {
  test(`GitHub plugin installation requires consent and displays pending installation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    const source = {
      repository: "https://github.com/example/plugin",
      commit: "a".repeat(40),
      path: "",
      digest: "b".repeat(64),
    };
    let installed = false;
    await page.route("**/api/install/plugins", (route) =>
      route.fulfill({
        json: {
          items: installed
            ? [{ id: "example-note", version: "1.0.0", source }]
            : [],
        },
      }),
    );
    await page.route("**/api/install/plugin/github/preview", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "example-note",
              description: "Synthetic plugin",
              version: "1.0.0",
              hasServerCode: true,
              source,
              token: "preview-token",
              expiresAt: Date.now() + 900_000,
            },
          ],
        },
      }),
    );
    await page.route("**/api/install/plugin/github", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        token: "preview-token",
        acceptRisk: true,
      });
      installed = true;
      await route.fulfill({
        status: 201,
        json: {
          ok: true,
          kind: "plugin",
          id: "example-note",
          restartRequired: true,
        },
      });
    });
    await page.goto("/session");
    await page
      .getByRole("button", { name: /Configure Providers & Models/ })
      .click();
    const dialog = page.getByRole("dialog");
    if (width < 640)
      await dialog
        .getByRole("combobox", { name: "Settings", exact: true })
        .selectOption("packages");
    else
      await dialog
        .getByRole("button", { name: "Install & manage", exact: true })
        .click();
    await expect(
      dialog.getByRole("link", { name: "Browse community plugins" }),
    ).toHaveAttribute("href", "https://github.com/covel-ai/covel-plugins");
    await dialog.getByLabel("GitHub URL").fill(source.repository);
    await dialog
      .getByRole("button", { name: "Preview plugin", exact: true })
      .click();
    const install = dialog.getByRole("button", {
      name: "Confirm installation",
    });
    await expect(install).toBeDisabled();
    await expect(dialog.getByText(/without a process sandbox/)).toBeVisible();
    expect(installed).toBe(false);
    await dialog
      .getByRole("checkbox", {
        name: "I understand the risks and trust this source.",
      })
      .check();
    await install.click();
    await expect(
      dialog.getByText("Installed; restart the backend to load this plugin."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Uninstall", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/Plugin files changed/)).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });
}
