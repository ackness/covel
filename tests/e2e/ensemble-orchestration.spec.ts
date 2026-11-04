import { expect, test } from "@playwright/test";
import {
  prepareEnsemble as prepare,
  ensembleReply as script,
} from "./helpers/ensemble.js";
import {
  closeStudioConfiguration,
  composer,
  composerInput,
  openStudioConfiguration,
  waitForTurnIdle,
} from "./helpers/player.js";

test.use({ viewport: { width: 1440, height: 1000 } });

test("host creation, fixed-order beats, manual names and settings survive reload", async ({
  page,
}) => {
  const f = await prepare(page);
  try {
    await f.strategy("list");
    await page.getByTestId("composer-mode-direct").click();
    await composerInput(page).fill("Mara and Ivo, greet each other.");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    expect(f.calls).toEqual(["Mara", "Ivo", "Mara", "Ivo", "Mara", "Ivo"]);
    await expect(
      page.getByText("Mara replies.", { exact: true }).first(),
    ).toBeVisible();
    const response = await page.request.get(
      `/api/sessions/${f.sessionId}/messages`,
      { headers: f.headers },
    );
    const messages = await response.json();
    expect(JSON.stringify(messages)).toContain("Ivo replies.");
    expect(JSON.stringify(messages)).not.toContain("PRIVATE-PERFORMER-INTENT");
    await page.reload();
    await openStudioConfiguration(page);
    await expect(
      page
        .getByRole("group", { name: "Orchestration", exact: true })
        .getByText(/^Turn Policy \/ /),
    ).toBeVisible();
    await expect(page.getByLabel("Turn policy", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByLabel("Automatic rounds", { exact: true }),
    ).toHaveValue("2");
    await closeStudioConfiguration(page);
    await expect(page.getByTestId("composer-mode-direct")).toBeVisible();
    await f.strategy("manual");
    await page.getByTestId("composer-mode-turn-policy/choose-actors").click();
    await page
      .getByTestId("composer-fields")
      .getByRole("textbox")
      .fill("Ivo\nMara");
    await composerInput(page).fill("Answer in that order.");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    expect(f.calls.slice(6)).toEqual(["Ivo", "Mara"]);
    expect(
      f.provider.requests.some((request) =>
        request.rawMessages.some((message) =>
          message.tool_calls?.some((call) => call.function.name === "delegate"),
        ),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("spectator sees advance only and an invalid actor loses only its contribution", async ({
  page,
}) => {
  const f = await prepare(page, "spectator", true);
  try {
    await f.strategy("list");
    for (const kind of ["direct", "say", "turn-policy/choose-actors"])
      await expect(page.getByTestId(`composer-mode-${kind}`)).toHaveCount(0);
    const advance = composer(page).getByRole("button", {
      name: "Advance",
      exact: true,
    });
    await expect(advance).toBeVisible();
    await expect(advance).toBeEnabled();
    await advance.click();
    await waitForTurnIdle(page);
    expect(f.calls).toEqual(["Mara", "Ivo", "Mara", "Ivo", "Mara", "Ivo"]);
    await expect(composer(page)).toHaveAttribute("data-executing", "false");
    const messages = await (
      await page.request.get(`/api/sessions/${f.sessionId}/messages`, {
        headers: f.headers,
      })
    ).json();
    expect(JSON.stringify(messages)).toContain("Mara replies.");
    expect(JSON.stringify(messages)).not.toContain("Ivo replies.");
  } finally {
    await f.close();
  }
});

for (const mode of ["Stop", "new input"])
  test(`a gated generated actor yields to ${mode} and preserves committed stories`, async ({
    page,
  }) => {
    const f = await prepare(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actors = 0;
    try {
      await f.strategy("list");
      f.provider.reply = (request) =>
        script(request, f.calls, false, () =>
          ++actors === 3 ? gate : undefined,
        );
      await page.getByTestId("composer-mode-direct").click();
      await composerInput(page).fill("Mara and Ivo, greet each other.");
      await composerInput(page).press("Enter");
      await expect.poll(() => actors).toBe(3);
      const aborted = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/sessions/${f.sessionId}/abort`) &&
          response.request().method() === "POST",
      );
      if (mode === "Stop")
        await page
          .getByTestId("notice-status-auto-advance")
          .click();
      else {
        await composerInput(page).fill("Mara and Ivo, begin a new exchange.");
        await composerInput(page).press("Enter");
      }
      expect((await aborted).ok()).toBe(true);
      release();
      await waitForTurnIdle(page);
      expect(f.calls).toHaveLength(mode === "Stop" ? 3 : 9);
      await expect(
        page.getByText("Mara replies.", { exact: true }).first(),
      ).toBeVisible();
      await expect(composer(page)).toHaveAttribute("data-executing", "false");
    } finally {
      release();
      await f.close();
    }
  });
