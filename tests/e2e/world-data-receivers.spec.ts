import { expect, test } from "@playwright/test";
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

for (const mode of ["ambiguous", "disabled"] as const) {
  test(`local receiver ${mode} keeps preparation and a committed story turn playable`, async ({
    page,
  }) => {
    const provider = await startFakeLlmProvider();
    provider.reply = (request) => {
      const facts = completedBusinessData(request, "submit-world-facts");
      if (facts)
        return submitOutputReply(facts.facts as Record<string, unknown>);
      return request.tools.some(
        (tool) => tool.function.name === "submit-world-facts",
      )
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
            ...submitOutputReply({
              segments: [
                {
                  kind: "narration",
                  text: "The lamp holds against the night.",
                },
              ],
              cues: { present: [] },
            }),
          };
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
    const catalogue = await (await page.request.get("/api/plugins")).json();
    for (const id of ["test-data-receiver-one", "test-data-receiver-two"])
      expect(catalogue.items).toContainEqual(
        expect.objectContaining({
          id,
          acceptsWorldData: expect.arrayContaining(["test.receiver-notes@1"]),
        }),
      );
    await page.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    const name = `Lamp ${mode} ${crypto.randomUUID()}`;
    const worldId = await page.evaluate(
      async ({ name, mode }) => {
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
                contract:
                  mode === "disabled"
                    ? "test.single-receiver-notes@1"
                    : "test.receiver-notes@1",
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
      },
      { name, mode },
    );
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
        .locator('[data-plugin-id="test-data-receiver-one"]')
        .getByRole("switch");
      await expect(receiver).toHaveAttribute(
        "aria-checked",
        mode === "ambiguous" ? "false" : "true",
      );
      const other = advanced
        .locator('[data-plugin-id="test-data-receiver-two"]')
        .getByRole("switch");
      await expect(other).toHaveAttribute("aria-checked", "false");
      if (mode === "ambiguous") {
        await expect(
          page.getByText(
            "Lamp notes: This data has no plugin to receive it. Choose a receiving plugin.",
            { exact: true },
          ),
        ).toBeVisible();
        const before = await page.request.post(
          `/api/worlds/${worldId}/world-data/preflight`,
          { data: { plugins: [] } },
        );
        expect(before.ok()).toBe(true);
        expect(await before.json()).toMatchObject({
          planned: 0,
          targets: [],
          diagnostics: [
            { code: "receiver-ambiguous", publicLabel: "Lamp notes" },
          ],
        });
      }
      await receiver.click();
      await expect(receiver).toHaveAttribute(
        "aria-checked",
        mode === "ambiguous" ? "true" : "false",
      );
      await expect(other).toHaveAttribute("aria-checked", "false");
      const start = page.getByRole("button", {
        name: "Start Game",
        exact: true,
      });
      await expect(start).toBeEnabled();
      if (mode === "disabled")
        await expect(
          page.getByText(
            "Lamp notes: This data has no plugin to receive it. Receiving plugins are disabled.",
            { exact: true },
          ),
        ).toHaveCount(1);
      await startGame(page, start);
      await expect(page).toHaveURL(/sid=/);
      await waitForTurnIdle(page);
      const sessionId = new URL(page.url()).searchParams.get("sid")!;
      // This pack has no setup runtime. Exercise play through a real action.
      const callsBeforeTurn = provider.requests.length;
      await sendPlayerMessage(page, "I tend the lamp.");
      await waitForTurnIdle(page);
      await expect(
        page
          .getByText("The lamp holds against the night.", { exact: true })
          .first(),
      ).toBeVisible();
      expect(provider.requests.length).toBeGreaterThan(callsBeforeTurn);
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
      const saved = await page.evaluate(async (id) => {
        const apiPath = "/src/services/api.ts";
        const { getSession, listPluginData } = await import(apiPath);
        return {
          session: await getSession(id),
          rows: await listPluginData(id, "test-data-receiver-one", "notes"),
          otherRows: await listPluginData(
            id,
            "test-data-receiver-two",
            "notes",
          ),
        };
      }, sessionId);
      expect(
        saved.session.metadata.pluginSelection.requiredDataContracts,
      ).toEqual([
        mode === "disabled"
          ? "test.single-receiver-notes@1"
          : "test.receiver-notes@1",
      ]);
      expect(
        saved.session.activePlugins.includes("test-data-receiver-one"),
      ).toBe(mode === "ambiguous");
      expect(saved.rows).toHaveLength(mode === "ambiguous" ? 1 : 0);
      expect(saved.otherRows).toEqual([]);
      expect(saved.session.activePlugins).not.toContain(
        "test-data-receiver-two",
      );
      expect(saved.session.completedPlayerTurns).toBe(1);
      if (mode === "disabled")
        await expect(
          page.getByTestId("notice-world-data:receiver-excluded"),
        ).toContainText("Receiving plugins are disabled.");
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
