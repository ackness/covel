import { expect, test, type Page } from "@playwright/test";
import {
  startFakeLlmProvider,
  type FakeChatRequest,
  type FakeReply,
} from "./helpers/fake-llm-provider.js";
import {
  closeStudioConfiguration,
  composer,
  composerInput,
  ONBOARDING_VERSION,
  openStudioConfiguration,
  seedBrowserSettings,
  selectWorldByText,
  startGame,
  useServerWorlds,
  waitForTurnIdle,
} from "./helpers/player.js";

test.use({ viewport: { width: 1440, height: 1000 } });
function script(
  request: FakeChatRequest,
  calls: string[],
  failActor = false,
  hold?: (name: string) => Promise<void> | undefined,
): FakeReply {
  const text = request.messages.join("\n");
  if (text.includes("Play only the character assigned")) {
    const name = text.includes('"name":"Mara"') ? "Mara" : "Ivo";
    return {
      text: JSON.stringify(
        failActor && name === "Ivo"
          ? { segments: [] }
          : {
              segments: [{ kind: "dialogue", text: `${name} replies.` }],
              intent: "PRIVATE-PERFORMER-INTENT",
            },
      ),
      hold: hold?.(name),
    };
  }
  const block = text.match(/<runtime-inputs>\n([\s\S]*?)\n<\/runtime-inputs>/);
  const inputs = block?.[1]
    ? (JSON.parse(
        block[1]
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ) as {
        plan?: {
          value?: {
            actors: { character: string }[];
            cast: string[];
            yieldHint: string;
          };
        };
      })
    : undefined;
  const plan = inputs?.plan?.value;
  const receipts = request.rawMessages.filter(
    (message) => message.role === "tool",
  );
  const next = plan?.actors[receipts.length];
  if (next) {
    expect(
      request.tools.some((tool) => tool.function.name === "delegate"),
    ).toBe(true);
    calls.push(next.character);
    return {
      text: "",
      toolCalls: [
        {
          id: `performer-${receipts.length}`,
          type: "function",
          function: {
            name: "delegate",
            arguments: JSON.stringify({
              target: { contract: "character-actor@1" },
              character: next.character,
              brief: "The bell rings. Respond briefly.",
            }),
          },
        },
      ],
    };
  }
  const segments = receipts.flatMap((message, index) => {
    const result = JSON.parse(String(message.content)) as {
      data?: { segments?: { kind: string; text: string }[] };
    };
    return (result.data?.segments ?? []).map((segment) => ({
      ...segment,
      speaker: plan!.actors[index]!.character,
    }));
  });
  return {
    text: JSON.stringify({
      segments: [
        ...segments,
        {
          kind: "narration",
          text: segments.length
            ? "The bell grows quiet."
            : "Mara and Ivo wait by the bell.",
        },
      ],
      cues: { present: plan?.cast.length ? plan.cast : ["Mara", "Ivo"] },
      yield: segments.length ? (plan?.yieldHint ?? "user") : "user",
    }),
  };
}

async function prepare(
  page: Page,
  role: "host" | "spectator" = "host",
  failActor = false,
) {
  const provider = await startFakeLlmProvider();
  const calls: string[] = [];
  provider.reply = (request) => script(request, calls, failActor);
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
  await useServerWorlds(page);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64");
  await page.route("**/api/actions", (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "x-slot-config": encode({
          customPresets: [
            {
              id: "ensemble-model",
              provider: "fake",
              model: "ensemble-test",
              protocol: "openai-chat-v1",
              baseUrl: provider.baseUrl,
            },
          ],
          slotBindings: {
            story: { modelRef: "ensemble-model" },
            plugin: { modelRef: "ensemble-model" },
          },
        }),
        "x-provider-keys": encode({ fake: "test-key" }),
      },
    }),
  );
  const worldId = `ensemble-${Date.now()}-${role}`;
  const name = `Ensemble hall ${worldId}`;
  const world = await page.request.post("/api/worlds", {
    data: {
      id: worldId,
      name,
      locale: "en-US",
      metadata: { pluginPolicy: { preset: "spectator", packs: ["spectator"] } },
    },
  });
  expect(world.ok(), await world.text()).toBe(true);
  await page.goto("/session");
  await selectWorldByText(page, new RegExp(name));
  await page.getByLabel("Play as", { exact: true }).selectOption(role);
  const start = page.getByRole("button", { name: "Start Game", exact: true });
  await expect(start).toBeEnabled();
  await page.getByRole("button", { name: /^Loaded Plugins/ }).click();
  const advanced = page.getByTestId("advanced-plugin-settings");
  await advanced.locator("summary").click();
  const excluded = [
    "pregame",
    "world-init",
    "world-time",
    "memory",
    "history-compaction",
  ];
  for (const id of excluded) {
    const toggle = advanced
      .locator(`[data-plugin-id="${id}"]`)
      .getByRole("switch");
    await expect(toggle).toBeEnabled();
    if ((await toggle.getAttribute("aria-checked")) === "true")
      await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  }
  for (const id of excluded) {
    await expect(
      advanced.locator(`[data-plugin-id="${id}"]`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "false");
  }
  const creation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions") &&
      response.request().method() === "POST",
  );
  await startGame(page, start);
  const created = await creation;
  const submitted = created.request().postDataJSON() as {
    plugins: string[];
    excludedPlugins: string[];
  };
  expect(submitted.excludedPlugins).toEqual(expect.arrayContaining(excluded));
  expect(submitted.plugins.filter((id) => excluded.includes(id))).toEqual([]);
  const session = (await created.json()) as {
    id: string;
    ownerToken?: string;
    activePlugins: string[];
    seats: { role: string; characters: string[] }[];
  };
  expect(session.activePlugins.filter((id) => excluded.includes(id))).toEqual(
    [],
  );
  expect(session.seats).toEqual([
    { id: "main", controller: "human", role, characters: [] },
  ]);
  const headers = session.ownerToken
    ? { "X-Session-Token": session.ownerToken }
    : {};
  for (const characterName of ["Mara", "Ivo"]) {
    const response = await page.request.post(
      `/api/sessions/${session.id}/characters`,
      {
        headers,
        data: {
          id: `ensemble-${characterName}`,
          name: characterName,
          type: "npc",
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page
    .getByRole("button", { name: "Begin Adventure", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Begin Adventure", exact: true }),
  ).toHaveCount(0);
  await waitForTurnIdle(page);
  await page.getByRole("button", { name: "Parsed view", exact: true }).click();
  await openStudioConfiguration(page);
  const orchestration = page.getByRole("group", {
    name: "Orchestration",
    exact: true,
  });
  await expect(orchestration.getByText(/^Turn Policy \/ /)).toBeVisible();
  await expect(orchestration.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save Turn policy", exact: true }),
  ).toHaveCount(0);
  const resolved = await page.request.get(
    `/api/sessions/${session.id}/orchestration`,
    { headers },
  );
  expect(await resolved.json()).toMatchObject({
    status: "unique",
    settings: { maxActors: 4, maxSubagentCalls: 16 },
  });
  expect((await resolved.json()).settings.turnPolicy).toBeUndefined();
  await page.getByLabel("Automatic rounds", { exact: true }).fill("2");
  const saveAdvance = page.getByRole("button", {
    name: "Save Automatic rounds",
    exact: true,
  });
  await saveAdvance.click();
  await expect(saveAdvance).toHaveText("Save");
  await expect(saveAdvance).toBeDisabled();
  await closeStudioConfiguration(page);
  const strategy = async (value: string) => {
    await openStudioConfiguration(page);
    await page.getByRole("button", { name: /^Settings for / }).click();
    const control = page
      .getByRole("dialog")
      .getByLabel("Strategy", { exact: true });
    await control.selectOption(value);
    await expect(control).toHaveValue(value);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await closeStudioConfiguration(page);
  };
  return {
    provider,
    calls,
    sessionId: session.id,
    headers,
    strategy,
    close: async () => {
      await page.goto("about:blank");
      await page.request.delete(`/api/sessions/${session.id}`, { headers });
      await page.request.delete(`/api/worlds/${worldId}`);
      await provider.close();
    },
  };
}

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
          .getByTestId("auto-advance-control")
          .getByRole("button", { name: "Stop advancement", exact: true })
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
