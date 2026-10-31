import { expect, test, type Page } from "@playwright/test";
import {
  startFakeLlmProvider,
  type FakeLlmProvider,
} from "./helpers/fake-llm-provider.js";
import {
  composerInput,
  seedAppSettings,
  useServerWorlds,
} from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

// The page may share a busy machine; allow a slow first load.
const LOADED = { timeout: 20_000 };

const PROVIDER = "fake";
const PRESET = "fake-narrator";

const AYA = { id: "e2e-aya", name: "阿雅", type: "player" };
const BO = { id: "e2e-bo", name: "阿波", type: "player" };

// Narrator only: the plugins it pulls in for a new game would start the
// session in setup, and this spec is about the composer, not game creation.
const EXCLUDED = [
  "char-creator",
  "pregame",
  "world-init",
  "world-time",
  "memory",
  "history-compaction",
];

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** Run the action's turn against the fake provider instead of a real model. */
async function useFakeModel(page: Page, provider: FakeLlmProvider) {
  await page.route("**/api/actions", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-slot-config": encode({
          customPresets: [
            {
              id: PRESET,
              provider: PROVIDER,
              model: "fake-model",
              baseUrl: provider.baseUrl,
              protocol: "openai-chat-v1",
            },
          ],
          slotBindings: {
            story: { modelRef: PRESET },
            plugin: { modelRef: PRESET },
          },
        }),
        "x-provider-keys": encode({ [PROVIDER]: "fake-test-key" }),
      },
    });
  });
}

// A real session whose seat binds two player characters. The server, the seat
// write, the action transport, the turn and the stored message are all real;
// only the model is a provider running in this process.
test("a second character acts in act mode and the bubble says who and how, also after a reload", async ({
  page,
}) => {
  const provider = await startFakeLlmProvider();
  provider.reply = () => ({ text: "夜雾漫过码头，阿波的手按在剑柄上。" });
  const worldId = `e2e-duo-${Date.now()}`;
  let sessionId: string | undefined;
  try {
    await seedAppSettings(page);
    await useServerWorlds(page);
    await useFakeModel(page, provider);

    const world = await page.request.post("/api/worlds", {
      data: { id: worldId, name: "Duo world", locale: "zh-CN" },
    });
    expect(world.ok(), await world.text()).toBeTruthy();
    const created = await page.request.post("/api/sessions", {
      data: {
        worldId,
        locale: "zh-CN",
        plugins: ["narrator"],
        excludedPlugins: EXCLUDED,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const record = (await created.json()) as {
      id: string;
      phase: string;
      seats: { id: string; role: string }[];
    };
    sessionId = record.id;
    expect(record.phase).toBe("playing");
    const seat = record.seats.find((candidate) => candidate.role === "player")!;
    for (const character of [AYA, BO]) {
      const added = await page.request.post(
        `/api/sessions/${sessionId}/characters`,
        { data: character },
      );
      expect(added.ok(), await added.text()).toBeTruthy();
    }

    const sent: { payload: { actions: { kind: string; text?: string }[] } }[] =
      [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/actions") && request.method() === "POST")
        sent.push(request.postDataJSON());
    });

    await page.goto(`/session?sid=${sessionId}`);
    await expect(composerInput(page)).toBeEnabled(LOADED);
    // The modes come from the session's action kinds.
    await expect(page.getByTestId("composer-mode-say")).toBeVisible();
    await expect(page.getByTestId("composer-mode-act")).toBeVisible();

    const switcher = page.getByTestId("composer-character-switcher");
    await expect(switcher).toBeVisible();
    await switcher.selectOption(BO.id);
    await expect(switcher).toHaveValue(BO.id);

    await page.getByTestId("composer-mode-act").click();
    await composerInput(page).fill("拔出剑");
    await composerInput(page).press("Enter");

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({
      type: "submit_actions",
      sessionId,
      payload: { actions: [{ kind: "act", text: "拔出剑" }] },
    });
    // No actor is sent: the server takes the seat's current character.
    expect(sent[0]!.payload.actions[0]).not.toHaveProperty("actorId");

    const label = page.locator('[data-role="user"] .ui-message-role').first();
    await expect(label).toContainText(`${BO.name} · 行动`);
    // The turn ran against the provider and its story was stored.
    await expect(page.locator(".ui-narrative")).toContainText("夜雾漫过码头", {
      timeout: 30_000,
    });
    expect(provider.requests.length).toBeGreaterThan(0);

    // The switch was stored, not only shown.
    const stored = await page.request.get(`/api/sessions/${sessionId}`);
    const seats = (
      (await stored.json()) as { seats: Record<string, unknown>[] }
    ).seats;
    expect(seats.find((candidate) => candidate.id === seat.id)).toMatchObject({
      currentCharacterId: BO.id,
    });

    await page.reload();
    await expect(composerInput(page)).toBeEnabled(LOADED);
    await expect(
      page.locator('[data-role="user"] .ui-message-role').first(),
    ).toContainText(`${BO.name} · 行动`);
    await expect(page.getByTestId("composer-character-switcher")).toHaveValue(
      BO.id,
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    if (sessionId) await page.request.delete(`/api/sessions/${sessionId}`);
    await page.request.delete(`/api/worlds/${worldId}`);
    await provider.close();
  }
});
