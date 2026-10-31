import { expect, test } from "@playwright/test";
import { startFakeLlmProvider } from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  startGame,
  waitForTurnIdle,
} from "./helpers/player.js";

for (const mode of ["ambiguous", "disabled"] as const) {
  test(`local receiver ${mode} keeps preparation and opening playable`, async ({
    page,
  }) => {
    const provider = await startFakeLlmProvider();
    provider.reply = (request) =>
      request.tools.some((tool) => tool.function.name === "submit-world-facts")
        ? {
            text: "",
            toolCalls: [
              {
                id: "facts",
                type: "function",
                function: {
                  name: "submit-world-facts",
                  arguments: JSON.stringify({
                    schemaVersion: 1,
                    summary: "The lamp holds.",
                    entities: [],
                    relations: [],
                    events: [],
                    statements: [],
                    objectiveAssessments: [],
                  }),
                },
              },
            ],
          }
        : {
            text: JSON.stringify({
              segments: [
                {
                  kind: "narration",
                  text: "The lamp holds against the night.",
                },
              ],
              cues: { present: [] },
            }),
          };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64");
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await page.route("**/api/actions", (route) =>
      route.continue({
        headers: {
          ...route.request().headers(),
          "x-slot-config": encode({
            customPresets: [
              {
                id: "lamp",
                provider: "fake",
                model: "lamp",
                protocol: "openai-chat-v1",
                baseUrl: provider.baseUrl,
              },
            ],
            slotBindings: {
              story: { modelRef: "lamp" },
              plugin: { modelRef: "lamp" },
            },
          }),
          "x-provider-keys": encode({ fake: "test-key" }),
        },
      }),
    );
    if (mode === "ambiguous") {
      // A second catalogue receiver exercises the chooser; actual creation
      // still selects the installed quest receiver and verifies its records.
      await page.route("**/api/plugins", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.items = body.items.map(
          (plugin: { id: string; acceptsWorldData?: string[] }) =>
            plugin.id === "inventory"
              ? {
                  ...plugin,
                  acceptsWorldData: [
                    ...(plugin.acceptsWorldData ?? []),
                    "quests@1",
                  ],
                }
              : plugin,
        );
        await route.fulfill({ response, json: body });
      });
    }
    await page.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    const name = `Lamp ${mode} ${crypto.randomUUID()}`;
    const worldId = await page.evaluate(async (name) => {
      const servicePath = "/src/services/data-service.ts";
      const service = (await import(servicePath)).getDataService();
      const world = await service.createWorld(name, "Keep the lamp.");
      await service.updateWorld(world.id, {
        locale: "en-US",
        lore: "The lamp holds.",
        metadata: {
          plugins: ["pack:narrative-only"],
          contractData: [
            {
              contract: "quests@1",
              key: "lamp",
              value: {
                id: "lamp",
                name: "Keep the lamp",
                description: "Keep the lamp lit.",
                status: "active",
              },
            },
          ],
        },
      });
      return world.id as string;
    }, name);
    try {
      await page.reload();
      await page
        .locator("article")
        .filter({ hasText: name })
        .getByRole("button", { name: "Enter", exact: true })
        .click();
      await page.getByRole("button", { name: /^Loaded Plugins/ }).click();
      const advanced = page.getByTestId("advanced-plugin-settings");
      await advanced.locator("summary").click();
      const receiver = advanced
        .locator('[data-plugin-id="core-quest"]')
        .getByRole("switch");
      await expect(receiver).toHaveAttribute(
        "aria-checked",
        mode === "ambiguous" ? "false" : "true",
      );
      await receiver.click();
      await expect(receiver).toHaveAttribute(
        "aria-checked",
        mode === "ambiguous" ? "true" : "false",
      );
      const start = page.getByRole("button", {
        name: "Start Game",
        exact: true,
      });
      await expect(start).toBeEnabled();
      if (mode === "disabled")
        await expect(
          page.getByText(
            "This data has no plugin to receive it. Receiving plugins are disabled.",
            { exact: true },
          ),
        ).toHaveCount(1);
      await startGame(page, start);
      await expect(page).toHaveURL(/sid=/);
      await waitForTurnIdle(page);
      const sessionId = new URL(page.url()).searchParams.get("sid")!;
      const saved = await page.evaluate(async (id) => {
        const apiPath = "/src/services/api.ts";
        const { getSession, listPluginData } = await import(apiPath);
        return {
          session: await getSession(id),
          rows: await listPluginData(id, "core-quest", "quests"),
        };
      }, sessionId);
      expect(
        saved.session.metadata.pluginSelection.requiredDataContracts,
      ).toEqual(["quests@1"]);
      expect(saved.session.activePlugins.includes("core-quest")).toBe(
        mode === "ambiguous",
      );
      expect(saved.rows).toHaveLength(mode === "ambiguous" ? 1 : 0);
      if (mode === "disabled")
        await expect(page.getByTestId("world-data-notices")).toContainText(
          "Receiving plugins are disabled.",
        );
    } finally {
      await page.evaluate(async (id) => {
        const servicePath = "/src/services/data-service.ts";
        const apiPath = "/src/services/api.ts";
        const service = (await import(servicePath)).getDataService();
        for (const session of await service.listSessions(id))
          await service.deleteSession(session.id);
        await service.deleteWorld(id);
        await (await import(apiPath)).deleteWorld(id);
      }, worldId);
      await provider.close();
    }
  });
}
