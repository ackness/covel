import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  startFakeLlmProvider,
  submitOutputReply,
  type FakeChatRequest,
  type FakeReply,
} from "./fake-llm-provider.js";
import {
  closeStudioConfiguration,
  ONBOARDING_VERSION,
  openStudioConfiguration,
  seedBrowserSettings,
  selectWorldByText,
  startGame,
  useServerWorlds,
  waitForTurnIdle,
} from "./player.js";

export function ensembleReply(
  request: FakeChatRequest,
  calls: string[],
  failActor = false,
  hold?: (name: string) => Promise<void> | undefined,
): FakeReply {
  const text = request.messages.join("\n");
  if (text.includes("Play only the character assigned")) {
    const name = text.includes('"name":"Mara"') ? "Mara" : "Ivo";
    return {
      ...submitOutputReply(
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
  const toolNames = new Map<string, string>();
  const receipts = request.rawMessages.filter((message) => {
    for (const call of message.tool_calls ?? [])
      toolNames.set(call.id, call.function.name);
    return (
      message.role === "tool" &&
      message.tool_call_id !== undefined &&
      toolNames.get(message.tool_call_id) === "delegate"
    );
  });
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
  return submitOutputReply({
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
  });
}

export async function prepareEnsemble(
  page: Page,
  role: "host" | "spectator" | "player" = "host",
  failActor = false,
  extraPlugins: readonly string[] = [],
) {
  const provider = await startFakeLlmProvider();
  const calls: string[] = [];
  provider.reply = (request) => ensembleReply(request, calls, failActor);
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
  const worldId = `ensemble-${role}-${randomUUID()}`;
  const name = `Ensemble hall ${worldId}`;
  const world = await page.request.post("/api/worlds", {
    data: {
      id: worldId,
      name,
      locale: "en-US",
      metadata: { plugins: ["pack:spectator"] },
    },
  });
  expect(world.ok(), await world.text()).toBe(true);
  await page.goto("/session");
  await selectWorldByText(page, new RegExp(name));
  // Creation waits for the full world record and its IndexedDB lore draft.
  // Concurrent browser starts can finish these after the summary has painted.
  const loreCard = page.getByRole("button", { name: /^World Document/ });
  await loreCard.click();
  await expect(
    page.getByRole("textbox", { name: "World Document", exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  await expect(
    page.getByRole("status").filter({ hasText: "Loading saved draft..." }),
  ).toHaveCount(0, { timeout: 30_000 });
  await loreCard.click();
  await page.getByLabel("Play as", { exact: true }).selectOption(role);
  await expect(page.getByLabel("Play as", { exact: true })).toHaveValue(role);
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
  for (const id of extraPlugins) {
    const toggle = advanced
      .locator(`[data-plugin-id="${id}"]`)
      .getByRole("switch");
    await expect(toggle).toBeEnabled();
    if ((await toggle.getAttribute("aria-checked")) !== "true")
      await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
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
    seats: { role: string; characters: string[] | "auto" }[];
  };
  expect(session.activePlugins.filter((id) => excluded.includes(id))).toEqual(
    [],
  );
  expect(session.seats).toEqual([
    {
      id: "main",
      controller: "human",
      role,
      characters: role === "player" ? "auto" : [],
    },
  ]);
  const headers: Record<string, string> = session.ownerToken
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
  if (role === "player") {
    const character = await page.request.post(
      `/api/sessions/${session.id}/characters`,
      {
        headers,
        data: {
          id: "rhea",
          name: "Rhea",
          type: "player",
          fields: { focus: 3 },
        },
      },
    );
    expect(character.ok(), await character.text()).toBe(true);
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
      try {
        await page.goto("about:blank");
        await page.request.delete(`/api/sessions/${session.id}`, { headers });
        await page.request.delete(`/api/worlds/${worldId}`);
      } catch (error) {
        // A timed-out test can close its context before cleanup begins.
        if (!page.isClosed()) throw error;
      } finally {
        await provider.close();
      }
    },
  };
}
