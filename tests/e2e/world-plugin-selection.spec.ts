import { expect, test } from "@playwright/test";
import { startFakeLlmProvider } from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  sendPlayerMessage,
  startGame,
  waitForTurnIdle,
} from "./helpers/player.js";

test("local world selection survives preparation, hydration, the first turn and reload", async ({
  page,
}) => {
  const provider = await startFakeLlmProvider();
  provider.reply = () => ({
    text: JSON.stringify({
      segments: [
        {
          kind: "narration",
          text: "The relay lamp holds against the long night.",
        },
      ],
      cues: { present: [] },
    }),
  });
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
    "plugin:dice-check",
    "contract:missing-check@1",
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
        metadata: { plugins },
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
    await dice.click();
    await initial.click();
    await expect(dice).toHaveAttribute("aria-checked", "false");
    await alternative.click();
    await expect(dice).toHaveAttribute("aria-checked", "false");
    await startGame(
      page,
      page.getByRole("button", { name: "Start Game", exact: true }),
    );
    await expect(page).toHaveURL(/sid=/);
    const sessionId = new URL(page.url()).searchParams.get("sid")!;
    // The chosen pack has no setup runtime, so the session starts in play.
    await sendPlayerMessage(page, "I trim the relay lamp.");
    await waitForTurnIdle(page);
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const credentialsPath = "/src/services/session-credentials.ts";
          const { getSessionToken } = await import(credentialsPath);
          const token = await getSessionToken(id);
          const response = await fetch(`/api/sessions/${id}/turns`, {
            headers: token ? { "X-Session-Token": token } : {},
          });
          const body = (await response.json()) as {
            items: { origin: string; commitStatus: string }[];
          };
          return body.items.some(
            (turn) =>
              turn.origin === "player" && turn.commitStatus === "committed",
          );
        }, sessionId),
      )
      .toBe(true);
    await page.reload();
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
        };
      },
      { sessionId, worldId },
    );
    expect(saved.worldMetadata.plugins).toEqual(plugins);
    expect(saved.worldMetadata).not.toHaveProperty("pluginPitch");
    expect(saved.selection).toMatchObject({
      excluded: expect.arrayContaining(["dice-check"]),
      requiredContracts: ["missing-check@1"],
    });
    expect(saved.active).toContain("narrator");
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
