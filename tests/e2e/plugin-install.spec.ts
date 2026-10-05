import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

for (const width of [1280, 390]) {
  test(`Multi-package GitHub installation requires consent for each selection at ${width}px`, async ({
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
      tracking: { kind: "default-branch" },
    };
    const previews = [
      {
        kind: "plugin",
        id: "example-note",
        description: "Synthetic plugin",
        version: "1.0.0",
        author: null,
        hasServerCode: true,
        source,
        token: "first-token",
        expiresAt: Date.now() + 900_000,
      },
      {
        kind: "plugin",
        id: "example-demo",
        description: "Synthetic demo",
        version: "1.0.0",
        author: null,
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
            pendingUpdate: null,
          })),
        },
      }),
    );
    await page.route("**/api/install/github/preview", (route) => {
      previewRequests++;
      return route.fulfill({
        json: { collection: null, items: previews, problems: [] },
      });
    });
    await page.route("**/api/install/github/batch", async (route) => {
      const expected = installed.length === 0 ? previews[1]! : previews[0]!;
      expect(route.request().postDataJSON()).toEqual({
        tokens: [expected.token],
        acceptRisk: true,
      });
      installed.push(expected);
      await route.fulfill({
        status: 201,
        json: {
          ok: true,
          installed: [{ kind: "plugin", id: expected.id }],
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
    await dialog
      .getByLabel("GitHub URL", { exact: true })
      .fill(source.repository);
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    const install = dialog.getByRole("button", {
      name: /^Install \d+ selected$/,
    });
    await expect(install).toBeDisabled();
    await expect(dialog.getByText(/without a process sandbox/)).toBeVisible();
    expect(installed).toHaveLength(0);
    const firstPackage = dialog.getByRole("checkbox", { name: /example-note/ });
    const secondPackage = dialog.getByRole("checkbox", {
      name: /example-demo/,
    });
    await expect(firstPackage).toBeChecked();
    await expect(secondPackage).toBeChecked();
    const consent = dialog.getByRole("checkbox", {
      name: "I understand the risks and trust this source.",
    });
    await consent.check();
    await firstPackage.uncheck();
    await expect(consent).not.toBeChecked();
    await expect(install).toBeDisabled();
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
    await expect(firstPackage).toBeVisible();
    await expect(secondPackage).toHaveCount(0);
    await firstPackage.check();
    await expect(install).toBeDisabled();

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
    await expect(dialog.getByText(/Package files changed/)).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });
}
