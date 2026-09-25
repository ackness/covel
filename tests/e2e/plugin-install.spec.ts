import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

for (const width of [1280, 390]) {
  test(`Multi-package GitHub installation requires consent for each package at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    const source = {
      repository: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      path: "plugins/note",
      digest: "b".repeat(64),
    };
    const previews = [
      {
        id: "example-note",
        description: "Synthetic plugin",
        version: "1.0.0",
        hasServerCode: true,
        source,
        token: "first-token",
        expiresAt: Date.now() + 900_000,
      },
      {
        id: "example-demo",
        description: "Synthetic demo",
        version: "1.0.0",
        hasServerCode: true,
        source: { ...source, path: "examples/demo" },
        token: "second-token",
        expiresAt: Date.now() + 900_000,
      },
    ];
    const installed: typeof previews = [];
    let previewRequests = 0;
    await page.route("**/api/install/plugins", (route) =>
      route.fulfill({
        json: {
          items: installed.map(({ id, version, source }) => ({
            id,
            version,
            source,
          })),
        },
      }),
    );
    await page.route("**/api/install/plugin/github/preview", (route) => {
      previewRequests++;
      return route.fulfill({ json: { items: previews } });
    });
    await page.route("**/api/install/plugin/github", async (route) => {
      const expected = installed.length === 0 ? previews[1]! : previews[0]!;
      expect(route.request().postDataJSON()).toEqual({
        token: expected.token,
        acceptRisk: true,
      });
      installed.push(expected);
      await route.fulfill({
        status: 201,
        json: {
          ok: true,
          kind: "plugin",
          id: expected.id,
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
    expect(installed).toHaveLength(0);
    const choice = dialog.getByRole("combobox", { name: "Choose a plugin" });
    await expect(choice.getByRole("option")).toHaveText([
      "example-note (plugins/note)",
      "example-demo (examples/demo)",
    ]);
    await choice.selectOption("1");
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
    ).toHaveCount(1);
    await expect(
      dialog.getByText("example-note · 1.0.0", { exact: true }),
    ).toBeVisible();
    await expect(install).toBeDisabled();
    const consent = dialog.getByRole("checkbox", {
      name: "I understand the risks and trust this source.",
    });
    await expect(consent).not.toBeChecked();
    await consent.check();
    await install.click();
    await expect(
      dialog.getByRole("button", { name: "Uninstall", exact: true }),
    ).toHaveCount(2);
    await expect(install).toHaveCount(0);
    expect(previewRequests).toBe(1);
    expect(installed.map((item) => item.id)).toEqual([
      "example-demo",
      "example-note",
    ]);
    await expect(dialog.getByText(/Plugin files changed/)).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });
}
