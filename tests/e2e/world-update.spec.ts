import { expect, test } from "@playwright/test";
import type { PluginInstallation } from "@covel/shared";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

for (const width of [1280, 390]) {
  test(`world update preview, consent, pending status and cancellation at ${width}px`, async ({
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
      path: "worlds/note",
      digest: "b".repeat(64),
      tracking: { kind: "branch" as const, ref: "main" },
    };
    const nextSource = {
      ...source,
      commit: "c".repeat(40),
      digest: "d".repeat(64),
    };
    let pending: PluginInstallation["pendingUpdate"] = null;
    await page.route("**/api/install/worlds", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "example-note",
              version: "1.0.0",
              source,
              pendingUpdate: pending,
            },
          ],
        },
      }),
    );
    await page.route("**/api/install/world/github/update/preview", (route) => {
      expect(route.request().postDataJSON()).toEqual({ id: "example-note" });
      return route.fulfill({
        json: {
          status: "available",
          preview: {
            id: "example-note",
            version: "1.1.0",
            description: "Updated plugin",
            hasServerCode: false,
            source: nextSource,
            previous: { version: "1.0.0", source },
            changes: {
              added: ["new.txt"],
              modified: ["world.yaml"],
              removed: [],
            },
            token: "update-token",
            expiresAt: Date.now() + 900_000,
          },
        },
      });
    });
    await page.route("**/api/install/world/github/update", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        token: "update-token",
        acceptRisk: true,
      });
      pending = { version: "1.1.0", source: nextSource, error: null };
      return route.fulfill({
        status: 201,
        json: {
          ok: true,
          kind: "world",
          id: "example-note",
          restartRequired: true,
        },
      });
    });
    await page.route(
      "**/api/install/world/github/update/example-note",
      (route) => {
        expect(route.request().method()).toBe("DELETE");
        pending = null;
        return route.fulfill({ json: { ok: true } });
      },
    );
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
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await expect(dialog.getByText("1.0.0 → 1.1.0")).toBeVisible();
    await expect(
      dialog.getByRole("link", {
        name: "Compare commits on GitHub (whole repository)",
      }),
    ).toHaveAttribute(
      "href",
      `${source.repository}/compare/${source.commit}...${nextSource.commit}`,
    );
    const confirm = dialog.getByRole("button", {
      name: "Confirm update",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await dialog
      .getByText("Files: +1 added, ~1 modified, −0 removed", { exact: true })
      .click();
    await expect(
      dialog.getByText("~ world.yaml", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("checkbox", {
        name: "I understand the risks and trust this source.",
        exact: true,
      })
      .check();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await confirm.click();
    await expect(
      dialog.getByText(
        "Update 1.1.0 is ready; restart the backend to apply it.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText("example-note · 1.0.0", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/Package files changed/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel pending update" }).click();
    await expect(
      dialog.getByRole("button", { name: "Check for updates" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Cancel pending update" }),
    ).toHaveCount(0);
    await expect(dialog.getByText(/Package files changed/)).toHaveCount(0);
  });
}
