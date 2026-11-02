import { expect, test } from "@playwright/test";
import {
  startFakeLlmProvider,
  submitOutputReply,
} from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  composerInput,
  expectPlayerCanAct,
  seedBrowserSettings,
  selectWorldByText,
  sendPlayerMessage,
  startGame,
  useServerWorlds,
  waitForTurnIdle,
} from "./helpers/player.js";

for (const explicitSetup of [false, true]) {
  test(
    explicitSetup
      ? "unfinished setup with no messages shows a recovery notice"
      : "Narrative Only begins Lantern Barrow and accepts the first player turn",
    async ({ page }) => {
      const provider = await startFakeLlmProvider();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sessionId: string | undefined;
      let headers: Record<string, string> = {};
      const text = "The lantern lights the path.";
      provider.reply = () => {
        return {
          hold: gate,
          ...submitOutputReply({
            segments: [{ kind: "narration", text }],
            cues: { present: [] },
          }),
        };
      };

      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64");
      await useServerWorlds(page);
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
      try {
        await page.goto("/session");
        await selectWorldByText(page, /Lantern Barrow|提灯古冢/);
        await page.getByRole("button", { name: /^Loaded Plugins/ }).click();
        await page
          .locator("button[aria-pressed]")
          .filter({ hasText: "Narrative Only" })
          .click();
        const advanced = page.getByTestId("advanced-plugin-settings");
        await advanced.locator("summary").click();
        const rules = advanced
          .locator('[data-plugin-id="tabletop-rules"]')
          .getByRole("switch");
        await expect(rules).toHaveAttribute("aria-checked", "false");
        if (explicitSetup) await rules.click();
        const creation = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/sessions") &&
            response.request().method() === "POST",
        );
        await startGame(
          page,
          page.getByRole("button", { name: "Start Game", exact: true }),
        );
        const created = (await (await creation).json()) as {
          id: string;
          ownerToken?: string;
        };
        sessionId = created.id;
        headers = created.ownerToken
          ? { "X-Session-Token": created.ownerToken }
          : {};
        await expect(page).toHaveURL(/sid=/);
        await expect(composerInput(page)).toBeVisible();
        await waitForTurnIdle(page);
        await expect(page.getByTestId("setup-progress-notice")).toHaveCount(0);
        const readSession = async () =>
          (
            await page.request.get(`/api/sessions/${sessionId}`, { headers })
          ).json();
        if (explicitSetup) {
          const begin = page.getByRole("button", {
            name: "Begin Adventure",
            exact: true,
          });
          await expect(begin).toBeVisible();
          release();
          const [action] = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/actions") &&
                response.request().method() === "POST" &&
                response.request().postDataJSON().sessionId === sessionId,
            ),
            begin.click(),
          ]);
          expect(action.ok()).toBe(true);
          await action.text();
          await waitForTurnIdle(page);
          await expect(page.getByTestId("setup-progress-notice")).toContainText(
            "A setup step is still waiting",
          );
          await expect(page.getByTestId("setup-progress-notice")).toContainText(
            "Tabletop Rules",
          );
          await expect(
            page.getByRole("button", { name: "Continue setup", exact: true }),
          ).toBeVisible();
          expect(await readSession()).toMatchObject({
            phase: "setup",
            completedPlayerTurns: 0,
            setupRuntimes: {
              "tabletop-rules/creation": { state: "pending", attempts: 1 },
            },
          });
          expect(provider.requests).toHaveLength(0);
          return;
        }
        // Without setup the session starts in playing; its first action comes
        // from the composer, rather than the setup-only Begin Adventure hero.
        await expectPlayerCanAct(page);
        await expect(
          page.getByRole("button", {
            name: "Begin Adventure",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(await readSession()).toMatchObject({
          phase: "playing",
          completedPlayerTurns: 0,
        });
        await sendPlayerMessage(page, "I lift the lantern.");
        await expect(page.getByTestId("story-segments")).toHaveCount(0);
        release();
        await waitForTurnIdle(page);
        await expectPlayerCanAct(page);
        await expect(
          page.getByText(text, { exact: true }).first(),
        ).toBeVisible();
        expect(await readSession()).toMatchObject({
          phase: "playing",
          completedPlayerTurns: 1,
        });
        const turns = (await (
          await page.request.get(`/api/sessions/${sessionId}/turns`, {
            headers,
          })
        ).json()) as {
          items: { commitStatus: string; origin: string }[];
        };
        expect(turns.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              commitStatus: "committed",
              origin: "player",
            }),
          ]),
        );
        await expect(
          page.getByText("I lift the lantern.", { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("setup-progress-notice")).toHaveCount(0);
      } finally {
        release();
        if (sessionId)
          await page.request.delete(`/api/sessions/${sessionId}`, { headers });
        await provider.close();
      }
    },
  );
}
