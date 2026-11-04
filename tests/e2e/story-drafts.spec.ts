import { expect, test, type Page } from "@playwright/test";
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

const opening = "The lantern lights the path.";
const reply = "“Stay close,” the keeper says.";

/**
 * Start a Narrative Only session whose next story streams its two lines and
 * holds the last argument piece until `release`, then run `steps`.
 */
async function withHeldStory(
  page: Page,
  steps: (held: {
    release: () => void;
    /** The saved messages' text, read from the server. */
    saved: () => Promise<string[]>;
  }) => Promise<void>,
) {
  const provider = await startFakeLlmProvider();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sessionId: string | undefined;
  let headers: Record<string, string> = {};
  provider.reply = () => ({
    ...submitOutputReply({
      segments: [
        { kind: "narration", text: opening },
        { kind: "dialogue", speaker: "Keeper", text: reply },
      ],
      cues: { present: ["Keeper"] },
    }),
    // Arguments arrive in pieces; the last one waits for the gate.
    streamMs: 600,
    hold: gate,
  });
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
    await expect(composerInput(page)).toBeVisible();
    await waitForTurnIdle(page);
    await expectPlayerCanAct(page);

    await steps({
      release,
      saved: async () => {
        const body = (await (
          await page.request.get(`/api/sessions/${sessionId}/messages`, {
            headers,
          })
        ).json()) as { items: { content: string }[] };
        return body.items.map((item) => item.content);
      },
    });
  } finally {
    release();
    if (sessionId)
      await page.request.delete(`/api/sessions/${sessionId}`, { headers });
    await provider.close();
  }
}

test("the story shows line by line while it is written, then becomes the turn's story", async ({
  page,
}) => {
  await withHeldStory(page, async ({ release, saved }) => {
    await sendPlayerMessage(page, "I lift the lantern.");
    // Both lines are finished before the held last piece; the turn is not.
    const draft = page.getByTestId("output-draft");
    await expect(draft).toContainText(opening);
    await expect(draft).toContainText(reply);
    await expect(draft).toHaveAttribute("data-draft-state", "writing");
    await expect(draft.getByRole("status")).toHaveText("Writing…");
    expect((await saved()).some((text) => text.includes(opening))).toBe(false);

    release();
    await waitForTurnIdle(page);
    await expect(draft).toHaveCount(0);
    // The committed story replaces the draft; it is not shown twice.
    await expect(page.getByText(opening, { exact: true })).toHaveCount(1);
    await expect(page.getByText(reply, { exact: true })).toHaveCount(1);
    await expectPlayerCanAct(page);
  });
});

test("the stage reads the story line by line while it is written and keeps the page", async ({
  page,
}) => {
  await withHeldStory(page, async ({ release, saved }) => {
    await page.getByRole("button", { name: /^Stage$/ }).click();
    const input = page.getByTestId("stage-decision-input");
    await expect(input).toBeEnabled();
    await input.fill("I lift the lantern.");
    await input.press("Enter");

    // The reader takes the panel's place while the turn runs.
    const panel = page.getByTestId("stage-draft-panel");
    const line = page.getByTestId("stage-reader-line");
    await expect(panel).toBeVisible();
    await expect(line).toHaveText(opening);
    await expect(page.getByTestId("stage-reader-status")).toHaveText(
      "Writing…",
    );
    await line.click();
    await expect(line).toHaveText(reply);
    await expect(page.getByTestId("stage-reader-speaker")).toHaveText("Keeper");
    // The last line written so far waits for the next one.
    await line.click();
    await expect(line).toHaveText(reply);
    expect((await saved()).some((text) => text.includes(opening))).toBe(false);

    release();
    // The committed story keeps the page instead of replaying it.
    await expect(panel).toHaveCount(0);
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await expect(line).toHaveText(reply);
    await expect(page.getByTestId("stage-reader-status")).toHaveCount(0);
    await line.click();
    await expect(page.getByTestId("stage-reader")).toHaveCount(0);
    expect((await saved()).some((text) => text.includes(opening))).toBe(true);
  });
});
