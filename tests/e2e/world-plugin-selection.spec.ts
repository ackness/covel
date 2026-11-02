import { expect, test } from "@playwright/test";
import type { ExecutionOrigin, RuntimeResult } from "@covel/shared";
import {
  startFakeLlmProvider,
  submitOutputReply,
  completedBusinessData,
} from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  sendPlayerMessage,
  startGame,
  waitForTurnIdle,
} from "./helpers/player.js";

test("local world selection survives preparation, hydration, the opening, the first turn and reload", async ({
  page,
}) => {
  const provider = await startFakeLlmProvider();
  provider.reply = (request) => {
    for (const name of [
      "submit-world-facts",
      "initialize-world",
      "advance-world-time",
    ]) {
      if (completedBusinessData(request, name)) return submitOutputReply({});
    }

    const systemPrompt = request.rawMessages
      .filter(({ role }) => role === "system" || role === "developer")
      .map(({ content }) => (typeof content === "string" ? content : ""))
      .join("\n");
    if (
      systemPrompt.includes("You are a memory manager.") ||
      systemPrompt.includes("你是一个记忆管理器。")
    )
      return submitOutputReply({});
    if (request.tools.some((tool) => tool.function.name === "initialize-world"))
      return {
        text: "",
        toolCalls: [
          {
            id: "initialize-watch",
            type: "function",
            function: {
              name: "initialize-world",
              arguments: JSON.stringify({
                attributes: [
                  "stats",
                  "bio",
                  "abilities",
                  "equipment",
                  "social",
                ].flatMap((category) =>
                  Array.from({ length: 3 }, (_, index) => ({
                    id: `${category}-${index}`,
                    name: `${category} ${index}`,
                    type: "number",
                    category,
                    defaultValue: 0,
                  })),
                ),
                definitions: {},
              }),
            },
          },
        ],
      };
    if (
      request.tools.some((tool) => tool.function.name === "advance-world-time")
    )
      return {
        text: "",
        toolCalls: [
          {
            id: "settle-watch-time",
            type: "function",
            function: {
              name: "advance-world-time",
              arguments: JSON.stringify({
                amount: 0,
                reason: "The relay watch remains in the same moment.",
              }),
            },
          },
        ],
      };
    if (
      request.tools.some((tool) => tool.function.name === "submit-world-facts")
    )
      return {
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
      };
    return {
      ...submitOutputReply({
        segments: [
          {
            kind: "narration",
            text: "The relay lamp holds against the long night.",
          },
        ],
        cues: { present: [] },
      }),
    };
  };
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64");
  await page.route("**/api/actions", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "x-slot-config": encode({
          customPresets: [
            {
              id: "watch-model",
              provider: "fake",
              model: "watch",
              protocol: "openai-chat-v1",
              baseUrl: provider.baseUrl,
            },
          ],
          slotBindings: {
            story: { modelRef: "watch-model" },
            plugin: { modelRef: "watch-model" },
          },
        }),
        "x-provider-keys": encode({ fake: "test-key" }),
      },
    }),
  );
  await page.goto("/session");
  await expect(page.locator("article").first()).toBeVisible();
  const name = `Long watch ${crypto.randomUUID()}`;
  const plugins = [
    "pack:traditional-story",
    "pack:narrative-only",
    "pack:dm-mode",
    "plugin:dice-check",
    "contract:session.opening@1",
  ];
  const worldId = await page.evaluate(
    async ({ name, plugins }) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      const service = getDataService();
      const world = await service.createWorld(name, "Keep the relay alive.");
      await service.updateWorld(world.id, {
        locale: "en-US",
        lore: "One relay, one lamp, one long night.",
        tags: ["frontier"],
        metadata: {
          plugins,
          contractData: [
            {
              contract: "quests@1",
              key: "relay",
              value: {
                id: "relay",
                name: "Keep the lamp",
                description: "Keep the relay alive.",
                status: "active",
              },
            },
          ],
        },
      });
      return world.id as string;
    },
    { name, plugins },
  );
  try {
    await page.reload();
    await page
      .locator("article")
      .filter({ hasText: name })
      .getByRole("button", { name: "Enter", exact: true })
      .click();
    await page.getByRole("button", { name: /^Loaded Plugins/ }).click();
    const initial = page
      .locator("button[aria-pressed]")
      .filter({ hasText: name });
    await expect(initial).toHaveAttribute("aria-pressed", "true");
    await expect(initial).toContainText("Keep the relay alive.");
    await expect(initial).toContainText("World tags: frontier");
    const alternative = page
      .locator("button[aria-pressed]")
      .filter({ hasText: "Narrative Only" });
    await alternative.click();
    const advanced = page.getByTestId("advanced-plugin-settings");
    await advanced.locator("summary").click();
    const dice = advanced
      .locator('[data-plugin-id="dice-check"]')
      .getByRole("switch");
    await expect(dice).toHaveAttribute("aria-checked", "true");
    await expect(
      advanced.locator('[data-plugin-id="core-quest"]').getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
    await dice.click();
    await initial.click();
    await expect(dice).toHaveAttribute("aria-checked", "false");
    await alternative.click();
    await expect(dice).toHaveAttribute("aria-checked", "false");
    const openingPack = page
      .locator("button[aria-pressed]")
      .filter({ hasText: "DM Mode" });
    await openingPack.click();
    await expect(openingPack).toHaveAttribute("aria-pressed", "true");
    await expect(dice).toHaveAttribute("aria-checked", "false");
    await expect(
      advanced.locator('[data-plugin-id="pregame"]').getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      advanced.locator('[data-plugin-id="world-init"]').getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
    await startGame(
      page,
      page.getByRole("button", { name: "Start Game", exact: true }),
    );
    await expect(page).toHaveURL(/sid=/);
    const sessionId = new URL(page.url()).searchParams.get("sid")!;
    await page
      .getByRole("button", { name: "Begin Adventure", exact: true })
      .click();
    const committedTurn = (kind: "opening" | "player") =>
      expect
        .poll(() =>
          page.evaluate(
            async ({ id, kind }) => {
              const origin: ExecutionOrigin =
                kind === "opening" ? "continuation" : "player";
              const credentialsPath = "/src/services/session-credentials.ts";
              const { getSessionToken } = await import(credentialsPath);
              const token = await getSessionToken(id);
              const response = await fetch(`/api/sessions/${id}/turns`, {
                headers: token ? { "X-Session-Token": token } : {},
              });
              const body = (await response.json()) as {
                items: {
                  origin: ExecutionOrigin;
                  commitStatus: string;
                  runtimeResults: RuntimeResult[];
                }[];
              };
              return body.items.some(
                (turn) =>
                  turn.origin === origin &&
                  turn.commitStatus === "committed" &&
                  turn.runtimeResults.some(
                    (result) =>
                      result.pluginId === "narrator" &&
                      result.status === "success",
                  ),
              );
            },
            { id: sessionId, kind },
          ),
        )
        .toBe(true);
    await committedTurn("opening");
    await waitForTurnIdle(page);
    await sendPlayerMessage(page, "I trim the relay lamp.");
    await waitForTurnIdle(page);
    await committedTurn("player");
    await page.reload();
    await committedTurn("opening");
    await committedTurn("player");
    const saved = await page.evaluate(
      async ({ sessionId, worldId }) => {
        const servicePath = "/src/services/data-service.ts";
        const apiPath = "/src/services/api.ts";
        const { getDataService } = await import(servicePath);
        const { getSession } = await import(apiPath);
        const world = await getDataService().getWorld(worldId);
        const session = await getSession(sessionId);
        return {
          worldMetadata: world?.metadata,
          active: session.activePlugins as string[],
          selection: session.metadata?.pluginSelection,
          data: await (
            await import(apiPath)
          ).listPluginData(sessionId, "core-quest", "quests"),
        };
      },
      { sessionId, worldId },
    );
    expect(saved.worldMetadata.plugins).toEqual(plugins);
    expect(saved.worldMetadata).not.toHaveProperty("pluginPitch");
    expect(saved.selection).toMatchObject({
      excluded: expect.arrayContaining(["dice-check"]),
      requiredContracts: ["session.opening@1"],
      requiredDataContracts: ["quests@1"],
    });
    expect(saved.active).toContain("pregame");
    expect(saved.active).toContain("narrator");
    expect(saved.active).toContain("core-quest");
    expect(saved.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "relay" })]),
    );
    expect(saved.active).not.toContain("dice-check");
  } finally {
    await page.evaluate(async (id) => {
      const servicePath = "/src/services/data-service.ts";
      const apiPath = "/src/services/api.ts";
      const { getDataService } = await import(servicePath);
      const { deleteWorld } = await import(apiPath);
      const service = getDataService();
      for (const session of await service.listSessions(id))
        await service.deleteSession(session.id);
      await service.deleteWorld(id);
      await deleteWorld(id);
    }, worldId);
    await provider.close();
  }
});
