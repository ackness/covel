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

test("TypeSafe models retain their native protocol across save and reload", async ({
  page,
}) => {
  const settings = await openProviderSettings(page);
  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .first()
    .click();
  const create = page.getByRole("dialog", {
    name: "Add provider",
    exact: true,
  });
  await create.getByPlaceholder("Provider ID, e.g. openai").fill("typesafe");
  await create
    .getByRole("combobox", { name: "API protocol", exact: true })
    .selectOption("evaluation");
  await expect(
    create.getByRole("combobox", { name: "Evaluation API", exact: true }),
  ).toHaveValue("typesafe-systemone-v1");
  await create
    .getByRole("textbox", { name: /^Model IDs(?:\s|$)/ })
    .fill("jev-latest");
  await create
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  const profile = (await savedEntries(page))["llm.providers"].find(
    (item: { id: string }) => item.id === "typesafe",
  );
  expect(profile).toMatchObject({
    baseUrl: "https://api.typesafe.ai/v1",
    protocol: "typesafe-systemone-v1",
    models: [{ modelId: "jev-latest" }],
  });
  expect((await savedEntries(page))["llm.slotConfig"]?.story).toBeUndefined();
  await page.reload();
  expect(
    (await savedEntries(page))["llm.providers"].find(
      (item: { id: string }) => item.id === "typesafe",
    ),
  ).toEqual(profile);
});

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

for (const { provider, model, protocol, baseUrl } of [
  {
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    protocol: "openrouter-decisions-v1",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    provider: "vercel",
    model: "typesafe-ai/jev",
    protocol: "vercel-evaluation-v4",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  {
    provider: "evaluation-proxy",
    model: "custom-judge",
    protocol: "vercel-evaluation-v4",
    baseUrl: "https://proxy.example/gateway/v1",
  },
]) {
  test(`${provider} shares its connection between chat and evaluation models`, async ({
    page,
  }) => {
    const settings = await openProviderSettings(page);
    await settings
      .getByRole("button", { name: "Add provider", exact: true })
      .first()
      .click();
    const create = page.getByRole("dialog", {
      name: "Add provider",
      exact: true,
    });
    await create.getByPlaceholder("Provider ID, e.g. openai").fill(provider);
    await create.getByPlaceholder("Base URL (optional)").fill(baseUrl);
    await create
      .getByRole("textbox", { name: /^Model IDs(?:\s|$)/ })
      .fill("synthetic-chat");
    await create
      .getByRole("button", { name: "Add provider", exact: true })
      .click();
    await expect(create).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    const add = page.getByRole("dialog", { name: "Add model", exact: true });
    await add.getByRole("textbox", { name: /^Model IDs(?:\s|$)/ }).fill(model);
    await add
      .getByRole("combobox", { name: "API protocol", exact: true })
      .selectOption("evaluation");
    if (provider === "evaluation-proxy") {
      await add
        .getByRole("combobox", { name: "Evaluation API", exact: true })
        .selectOption(protocol);
    }
    await expect(
      add.getByRole("combobox", { name: "Evaluation API", exact: true }),
    ).toHaveValue(protocol);
    await add
      .getByRole("button", { name: "Add 1 models", exact: true })
      .click();
    await expect(add).toHaveCount(0);
    const profiles = (await savedEntries(page))["llm.providers"];
    const profile = profiles.find(
      (item: { id: string }) => item.id === provider,
    );
    expect(profile).toMatchObject({
      baseUrl,
      protocol: "openai-chat-v1",
      models: [{ modelId: "synthetic-chat" }, { modelId: model, protocol }],
    });
    const row = settings.getByRole("group", { name: model, exact: true });
    await expect(
      row.getByRole("combobox", { name: "API protocol", exact: true }),
    ).toHaveValue("evaluation");
    await expect(
      row.getByRole("combobox", { name: "Evaluation API", exact: true }),
    ).toHaveValue(protocol);
    // Exercise the same request overlay consumed by server-side ping routing.
    await page.route("**/api/ai/ping", (route) =>
      route.fulfill({ json: { ok: true, latencyMs: 1 } }),
    );
    const request = page.waitForRequest("**/api/ai/ping");
    await row.getByRole("button", { name: /Ping/ }).click();
    const overlay = JSON.parse(
      Buffer.from(
        (await request).headers()["x-slot-config"]!,
        "base64",
      ).toString("utf8"),
    );
    expect(overlay.customPresets).toContainEqual(
      expect.objectContaining({
        provider,
        baseUrl,
        model,
        protocol,
      }),
    );
    await page.reload();
    expect((await savedEntries(page))["llm.providers"]).toEqual(profiles);
  });
}
