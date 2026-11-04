import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  createWorld,
  writeWorldPackage,
} from "../../packages/create/src/index.js";
import {
  startFakeLlmProvider,
  submitOutputReply,
  completedBusinessData,
} from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  startGame,
  waitForTurnIdle,
} from "./helpers/player.js";

test("portable dimensions survive editor save, hydration and opening, and an explicit clear stays empty", async ({
  page,
}) => {
  const id = `dimension-world-${crypto.randomUUID()}`;
  const dimensions = {
    alarm: {
      name: "Harbor alarm",
      schema: { type: "integer" as const, minimum: 0 },
      initialValue: 17,
    },
  };
  const generated = await createWorld({
    concept: "Keep the harbor lamp lit.",
    locale: "en-US",
    llm: {
      async generate() {
        return {
          content: `===WORLD_YAML===\nid: ${id}\nname: Harbor watch\nsummary: Keep the lamp lit.\ndefaultLocale: en-US\nplugins: [pack:narrative-only, contract:world.dimensions@1]\ncharacterSchema: {types: [npc], attributes: []}\n===WORLD_MD===\n# Harbor watch\nThe lamp guards the harbor.\n1. Guard it.\n2. Find oil.\n3. Watch the tide.\n===WORLD_PACKAGE_YAML===\n${JSON.stringify({ dimensions })}\n===END===`,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
  });
  expect(generated.success).toBe(true);
  if (!generated.success) throw new Error(generated.errors.join("; "));
  const directory = await mkdtemp(
    path.join(tmpdir(), "covel-dimension-export-"),
  );
  const provider = await startFakeLlmProvider();
  provider.reply = (request) => {
    const facts = completedBusinessData(request, "submit-world-facts");
    if (facts) return submitOutputReply(facts.facts as Record<string, unknown>);
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
                text: "The harbor lamp holds against the night.",
              },
            ],
            cues: { present: [] },
          }),
        };
  };

  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64");
  await page.route("**/api/actions", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "x-provider-keys": encode({ fake: "test-key" }),
        "x-slot-config": encode({
          customPresets: [
            {
              id: "harbor",
              provider: "fake",
              model: "harbor",
              protocol: "openai-chat-v1",
              baseUrl: provider.baseUrl,
            },
          ],
          slotBindings: {
            story: { modelRef: "harbor" },
            plugin: { modelRef: "harbor" },
          },
        }),
      },
    }),
  );
  try {
    await writeWorldPackage(directory, generated);
    expect(
      parse(await readFile(path.join(directory, id, "world.yaml"), "utf8")),
    ).not.toHaveProperty("dimensions");
    expect(
      parse(
        await readFile(
          path.join(directory, id, "data/dimensions.yaml"),
          "utf8",
        ),
      ),
    ).toEqual(dimensions);
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await page.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    await page.evaluate(
      async ({ id, dimensions, manifest, lore }) => {
        const servicePath = "/src/services/data-service.ts";
        const service = (await import(servicePath)).getDataService();
        await service.saveGeneratedWorld({
          id,
          name: "Harbor watch",
          description: "Keep the lamp lit.",
          locale: "en-US",
          lore,
          metadata: {
            dimensions,
            plugins: manifest.plugins,
            characterSchema: manifest.characterSchema,
          },
          createdAt: "2026-10-31T00:00:00Z",
        });
      },
      { id, dimensions, manifest: generated.manifest, lore: generated.lore },
    );
    for (const clear of [false, true]) {
      await page.goto("/session");
      await page.reload();
      const card = page.locator("article").filter({ hasText: "Harbor watch" });
      await card
        .getByRole("button", { name: "View Details", exact: true })
        .click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .locator("#dimension-declarations")
        .fill(
          JSON.stringify(
            clear ? {} : { alarm: { ...dimensions.alarm, initialValue: 23 } },
          ),
        );
      await page
        .getByRole("button", { name: "Apply definitions", exact: true })
        .click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      // The editor returns to details only after the locked IndexedDB write
      // commits. A click alone can still leave that write pending at unload.
      await expect(
        page.getByRole("button", { name: "Edit", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(async (id) => {
          const servicePath = "/src/services/data-service.ts";
          return (
            await (await import(servicePath)).getDataService().getWorld(id)
          )?.dimensions;
        }, id),
      ).toEqual(
        clear ? {} : { alarm: { ...dimensions.alarm, initialValue: 23 } },
      );
      await page.goto("/session");
      await page.reload();
      await card.getByRole("button", { name: "Enter", exact: true }).click();
      const startButton = page.getByRole("button", {
        name: "Start Game",
        exact: true,
      });
      await expect(startButton).toBeEnabled();
      await page.getByRole("button", { name: /^Loaded Plugins/ }).click();
      const advanced = page.getByTestId("advanced-plugin-settings");
      await advanced.locator("summary").click();
      const dimensionProvider = advanced
        .locator('[data-plugin-id="world-init"]')
        .getByRole("switch");
      // Narrative Only explicitly excludes this provider; a contract request
      // preserves that choice until the player turns the provider on.
      if ((await dimensionProvider.getAttribute("aria-checked")) === "false")
        await dimensionProvider.click();
      await expect(dimensionProvider).toHaveAttribute("aria-checked", "true");
      await startGame(page, startButton);
      await expect(page).toHaveURL(/sid=/);
      const sessionId = new URL(page.url()).searchParams.get("sid")!;
      const prepared = await page.evaluate(async (sessionId) => {
        const apiPath = "/src/services/api.ts";
        return (await import(apiPath)).getSession(sessionId);
      }, sessionId);
      expect([...prepared.activePlugins].sort()).toEqual([
        "narrator",
        "world-init",
      ]);
      expect(prepared.phase).toBe("setup");
      // Session creation does not execute setup or its opening continuation.
      await page
        .getByRole("button", { name: "Begin Adventure", exact: true })
        .click();
      await expect(
        page
          .getByText("The harbor lamp holds against the night.", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await waitForTurnIdle(page);
      await page.reload();
      await expect(
        page
          .getByText("The harbor lamp holds against the night.", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      const state = await page.evaluate(
        async ({ id, sessionId }) => {
          const servicePath = "/src/services/data-service.ts";
          const apiPath = "/src/services/api.ts";
          const service = (await import(servicePath)).getDataService();
          return {
            world: await service.getWorld(id),
            snapshot: await (await import(apiPath)).getSessionView(sessionId),
          };
        },
        { id, sessionId },
      );
      expect(state.world?.dimensions).toEqual(
        clear ? {} : { alarm: { ...dimensions.alarm, initialValue: 23 } },
      );
      expect(state.snapshot.dimensions).toEqual(
        clear
          ? {}
          : expect.objectContaining({
              alarm: expect.objectContaining({ value: 23 }),
            }),
      );
      expect(state.snapshot.session.phase).toBe("playing");
      expect(state.snapshot.session.completedPlayerTurns).toBe(0);
      await page.getByRole("tab", { name: "World", exact: true }).click();
      if (!clear) {
        await expect(
          page.getByRole("heading", { name: "Harbor alarm", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("23", { exact: true }).first(),
        ).toBeVisible();
      } else
        await expect(
          page.getByRole("heading", { name: "Harbor alarm", exact: true }),
        ).toHaveCount(0);
    }
  } finally {
    await page.evaluate(async (id) => {
      const servicePath = "/src/services/data-service.ts";
      const apiPath = "/src/services/api.ts";
      const service = (await import(servicePath)).getDataService();
      for (const session of await service.listSessions(id))
        await service.deleteSession(session.id);
      await service.deleteWorld(id);
      await (await import(apiPath)).deleteWorld(id);
    }, id);
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
