import { expect, test, type Page } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openProviderSettings(page: Page) {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
  await page.goto("/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/ })
    .click();
  return page.getByRole("dialog");
}

async function savedEntries(page: Page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("covel:settings")!).entries,
  );
}

test("failed provider creation keeps its draft and deleting its last model retains the connection", async ({
  page,
}) => {
  const settings = await openProviderSettings(page);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    let fail = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === "covel:settings" && fail) {
        const entries = JSON.parse(value).entries;
        if (
          entries["llm.providers"]?.some(
            (profile: { id: string }) => profile.id === "lifecycle-fixture",
          )
        ) {
          fail = false;
          throw new DOMException(
            "Synthetic test failure",
            "QuotaExceededError",
          );
        }
      }
      return setItem.call(this, key, value);
    };
  });
  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .first()
    .click();
  const create = page.getByRole("dialog", {
    name: "Add provider",
    exact: true,
  });
  await create
    .getByPlaceholder("Provider ID, e.g. openai")
    .fill("lifecycle-fixture");
  await create
    .getByRole("textbox", { name: /^Model IDs(?:\s|$)/ })
    .fill("synthetic-model");
  await create
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await expect(create.getByRole("alert")).toHaveText("Could not save setting");
  await expect(
    create.getByRole("textbox", { name: /^Model IDs(?:\s|$)/ }),
  ).toHaveValue("synthetic-model");
  expect((await savedEntries(page))["llm.providers"]).toBeUndefined();
  await create
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  await settings
    .getByRole("group", { name: "synthetic-model", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect
    .poll(async () => (await savedEntries(page))["llm.providers"]?.[0]?.models)
    .toEqual([]);
  await expect(
    settings.getByRole("button", { name: /lifecycle-fixture.*0 models/ }),
  ).toBeVisible();
  await page.reload();
  expect((await savedEntries(page))["llm.providers"][0].id).toBe(
    "lifecycle-fixture",
  );
});

test("an import finishing after a connection edit reports a conflict and preserves that edit", async ({
  page,
}) => {
  const settings = await openProviderSettings(page);
  const profile = {
    id: "import-fixture",
    name: "Import fixture",
    baseUrl: "https://original.example/v1",
    models: [{ ref: "import-model", modelId: "synthetic-model" }],
  };
  const file = (name: string) => ({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 2, providers: [profile] })),
  });
  await settings
    .getByLabel("Import", { exact: true })
    .setInputFiles(file("current.json"));
  await expect
    .poll(async () => (await savedEntries(page))["llm.providers"])
    .toEqual([profile]);
  await settings
    .getByRole("button", { name: /import-fixture.*1 models/ })
    .click();
  await page.evaluate(() => {
    const read = File.prototype.text;
    const control = window as unknown as { releaseProviderImport?: () => void };
    File.prototype.text = async function () {
      const content = await read.call(this);
      if (this.name === "delayed.json") {
        await new Promise<void>((resolve) => {
          control.releaseProviderImport = resolve;
        });
      }
      return content;
    };
  });
  await settings
    .getByLabel("Import", { exact: true })
    .setInputFiles(file("delayed.json"));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { releaseProviderImport?: () => void })
            .releaseProviderImport,
      ),
    )
    .toBe("function");
  await settings
    .getByRole("textbox", { name: "API endpoint", exact: true })
    .fill("https://edited.example/v1");
  await settings
    .getByRole("textbox", { name: "API endpoint", exact: true })
    .press("Tab");
  await expect
    .poll(async () => (await savedEntries(page))["llm.providers"][0].baseUrl)
    .toBe("https://edited.example/v1");
  await page.evaluate(() =>
    (
      window as unknown as { releaseProviderImport: () => void }
    ).releaseProviderImport(),
  );
  await expect(settings.getByRole("alert")).toContainText(
    "Model settings changed while reading the file",
  );
  expect((await savedEntries(page))["llm.providers"][0].baseUrl).toBe(
    "https://edited.example/v1",
  );
});
