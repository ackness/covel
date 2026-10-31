import { expect, test, type Page } from "@playwright/test";
import { prepareEnsemble, ensembleReply } from "./helpers/ensemble.js";
import {
  closeStudioConfiguration,
  composerInput,
  openStudioConfiguration,
  waitForTurnIdle,
} from "./helpers/player.js";

async function openView(page: Page, label: string) {
  await page
    .getByTestId("center-panel")
    .getByRole("button", { name: "Plugin views", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Plugin views", exact: true })
    .getByRole("button", { name: new RegExp(`^${label}`) })
    .click();
  await expect(page.getByTestId("plugin-view-bar")).toContainText(label);
}
async function back(page: Page) {
  await page
    .getByTestId("plugin-view-bar")
    .getByRole("button", { name: "Back to default view", exact: true })
    .click();
}

test.use({ viewport: { width: 1440, height: 1000 } });
test("real bundled graph and codex pages share committed data with their panels", async ({
  page,
}) => {
  const f = await prepareEnsemble(page, "host", false, ["npc-graph", "codex"]);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const put = async (
    plugin: string,
    namespace: string,
    key: string,
    value: unknown,
  ) => {
    const response = await page.request.put(
      `/api/sessions/${f.sessionId}/plugin-data/${plugin}/${namespace}/${key}`,
      { headers: f.headers, data: { value } },
    );
    expect(response.ok(), await response.text()).toBe(true);
  };
  try {
    await openView(page, "Relationship Graph");
    await expect(page.getByTestId("plugin-view-container")).toContainText(
      "No character or faction relationships yet.",
    );
    await put("npc-graph", "nodes", "mara", {
      id: "mara",
      name: "Mara",
      type: "individual",
      summary: "Public navigator",
    });
    await put("npc-graph", "nodes", "ivo", {
      id: "ivo",
      name: "Ivo",
      type: "individual",
    });
    await put("npc-graph", "edges", "current", {
      id: "current",
      source: "mara",
      target: "ivo",
      relation: "friend",
      fact: "They sail together.",
      strength: 1,
      validAt: 1,
    });
    const graph = page.getByTestId("plugin-view-container");
    await graph
      .getByRole("button", { name: "Mara", exact: true })
      .first()
      .click();
    await expect(graph).toContainText("Public navigator");
    await expect(graph).toContainText("They sail together.");
    await back(page);
    await page
      .getByRole("tab", { name: "Relationship Graph", exact: true })
      .click();
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Mara", exact: true })
      .first()
      .click();
    await expect(page.getByRole("tabpanel")).toContainText("Public navigator");
    await openView(page, "Codex");
    await expect(page.getByTestId("plugin-view-container")).toContainText(
      "No matching entries",
    );
    await put("codex", "entries", "map", {
      title: "Moon map",
      category: "item",
      content: "The complete northern chart.",
      tags: ["silver-sigil"],
      rarity: "rare",
    });
    const library = page.getByTestId("plugin-view-container");
    await library.getByPlaceholder("Search entries…").fill("silver-sigil");
    await library.getByText("Moon map", { exact: true }).click();
    await expect(library).toContainText("The complete northern chart.");
    await expect(library).toContainText("1 entries collected");
    await put("codex", "entries", "map", {
      title: "Moon map",
      category: "item",
      content: "The committed chart changed.",
      tags: ["silver-sigil"],
      rarity: "rare",
    });
    await expect(library).toContainText("The committed chart changed.");
    await page.getByRole("tab", { name: "Codex", exact: true }).click();
    await page
      .getByRole("tabpanel")
      .getByText("Moon map", { exact: true })
      .click();
    await expect(page.getByRole("tabpanel")).toContainText(
      "The committed chart changed.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await library.getByPlaceholder("Search entries…").fill("unmatched");
    await expect(library).toContainText("No matching entries");
    await expect(
      page
        .getByTestId("plugin-view-bar")
        .getByRole("button", { name: "Back to default view" }),
    ).toBeInViewport();
    await back(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openView(page, "Codex");
    await openStudioConfiguration(page);
    await page.getByRole("switch", { name: /^Codex:/ }).click();
    await closeStudioConfiguration(page);
    await expect(page.getByTestId("plugin-view-bar")).toHaveCount(0);
    // Disabled data remains durable; re-enable before reading through its normal API.
    await openStudioConfiguration(page);
    await page.getByRole("switch", { name: /^Codex:/ }).click();
    await closeStudioConfiguration(page);
    await openView(page, "Codex");
    await expect(library).toContainText("Moon map");
    const data = await page.request.get(
      `/api/sessions/${f.sessionId}/plugin-data/codex/entries/map`,
      { headers: f.headers },
    );
    expect(JSON.stringify(await data.json())).toContain(
      "The committed chart changed.",
    );
    const callsBeforeNavigation = f.provider.requests.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: /primary|主导航|основное/i })
      .click();
    await page
      .getByRole("combobox", { name: /language|语言|язык/i })
      .selectOption("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.keyboard.press("Escape");
    for (const label of ["知识图鉴", "关系图谱", "主持人控制台"]) {
      await page
        .getByTestId("center-panel")
        .getByRole("button", { name: "插件视图", exact: true })
        .click();
      await page
        .getByRole("group", { name: "插件视图", exact: true })
        .getByRole("button", { name: new RegExp(`^${label}`) })
        .click();
      await expect(page.getByTestId("plugin-view-bar")).toContainText(label);
    }
    await expect(page.getByTestId("plugin-view-container")).toContainText(
      "待处理交互",
    );
    expect(f.provider.requests).toHaveLength(callsBeforeNavigation);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally {
    await f.close();
  }
});

test("host console sends admitted Direct and textless Advance while retaining drafts and public privacy", async ({
  page,
}) => {
  const f = await prepareEnsemble(page);
  try {
    await f.strategy("manual");
    await openView(page, "DM Console");
    const content = page.getByTestId("plugin-view-container");
    await expect(content).toContainText("Mara");
    await expect(content).toContainText("Pending interactions");
    await expect(content).toContainText("No pending interactions.");
    await page.getByTestId("composer-mode-direct").click();
    await composerInput(page).fill("Mara, answer the bell.");
    await back(page);
    await expect(composerInput(page)).toHaveValue("Mara, answer the bell.");
    await openView(page, "DM Console");
    const request = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/actions") && request.method() === "POST",
    );
    await composerInput(page).press("Enter");
    expect((await request).postDataJSON()).toMatchObject({
      type: "submit_actions",
      payload: {
        actions: [
          { kind: "direct", text: "Mara, answer the bell.", seatId: "main" },
        ],
      },
    });
    await waitForTurnIdle(page);
    await f.strategy("list");
    await page.getByTestId("composer-mode-advance").click();
    const advance = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/actions") && request.method() === "POST",
    );
    await page.locator(".ui-composer-submit").click();
    const submitted = (await advance).postDataJSON() as {
      payload: { actions: Record<string, unknown>[] };
    };
    expect(submitted.payload.actions).toEqual([
      { kind: "advance", seatId: "main" },
    ]);
    await waitForTurnIdle(page);
    await expect(
      content.getByText("Mara replies.", { exact: true }).last(),
    ).toBeVisible();
    const messages = await page.request.get(
      `/api/sessions/${f.sessionId}/messages`,
      { headers: f.headers },
    );
    const saved = JSON.stringify(await messages.json());
    expect(saved).toContain('"kind":"direct"');
    expect(saved).toContain("Mara replies.");
    expect(saved).not.toContain("PRIVATE-PERFORMER-INTENT");
    await expect(content).not.toContainText("PRIVATE-PERFORMER-INTENT");
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page
        .getByTestId("plugin-view-bar")
        .getByRole("button", { name: "Back to default view" }),
    ).toBeInViewport();
  } finally {
    await f.close();
  }
});

test("spectator console exposes only Advance", async ({ page }) => {
  const f = await prepareEnsemble(page, "spectator");
  try {
    await f.strategy("list");
    await openView(page, "DM Console");
    await expect(page.getByTestId("plugin-view-container")).toContainText(
      "Mara and Ivo wait by the bell.",
    );
    await expect(
      page.getByTestId("game-composer").getByRole("button", {
        name: "Advance",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(page.getByTestId("composer-mode-direct")).toHaveCount(0);
    await page.locator(".ui-composer-submit").click();
    await waitForTurnIdle(page);
    await expect(page.getByTestId("plugin-view-container")).toContainText(
      "Mara replies.",
    );
  } finally {
    await f.close();
  }
});

test("a real pending form retains rejected input and resolves through normal admission", async ({
  page,
}) => {
  const f = await prepareEnsemble(page, "player", false, ["tabletop-rules"]);
  try {
    const seeded = await page.request.put(
      `/api/sessions/${f.sessionId}/plugin-data/tabletop-rules/setup/rules`,
      {
        headers: f.headers,
        data: {
          value: {
            budget: 4,
            attributes: [{ id: "focus", label: "Focus", base: 1, max: 5 }],
          },
        },
      },
    );
    expect(seeded.ok(), await seeded.text()).toBe(true);
    const committedRules = await page.request.get(
      `/api/sessions/${f.sessionId}/plugin-data/tabletop-rules/setup/rules`,
      { headers: f.headers },
    );
    expect(committedRules.ok(), await committedRules.text()).toBe(true);
    expect(await committedRules.json()).toMatchObject({
      value: {
        budget: 4,
        attributes: [{ id: "focus", label: "Focus", base: 1, max: 5 }],
      },
    });
    const opened = await page.request.post(
      `/api/sessions/${f.sessionId}/plugin-rpc`,
      {
        headers: f.headers,
        data: {
          kind: "runtime",
          pluginId: "tabletop-rules",
          runtimeId: "tabletop-rules/check",
          payload: { openForm: true },
        },
      },
    );
    expect(opened.ok(), await opened.text()).toBe(true);
    await page.reload();
    await openView(page, "DM Console");
    const pending = page.getByTestId("plugin-view-container");
    await expect(
      pending.getByText("Attribute check", { exact: true }),
    ).toHaveCount(1);
    await pending
      .getByLabel("Attempted action", { exact: false })
      .fill("Inspect the bell");
    const attribute = pending.getByRole("combobox", {
      name: "Attribute",
      exact: true,
    });
    await expect(attribute.locator('option[value="focus"]')).toHaveText(
      "Focus",
    );
    await attribute.selectOption("focus");
    await expect(attribute).toHaveValue("focus");
    let refused = false;
    await page.route("**/api/actions", async (route) => {
      const body = route.request().postDataJSON() as {
        payload?: {
          actions?: {
            interaction?: unknown;
            fields?: Record<string, unknown>;
          }[];
        };
      };
      const answer = body.payload?.actions?.find(
        (action) => action.interaction,
      );
      if (answer && !refused) {
        refused = true;
        answer.fields = { ...answer.fields, attribute: "invalid-attribute" };
        await route.fallback({ postData: JSON.stringify(body) });
      } else await route.fallback();
    });
    await pending
      .getByRole("button", { name: "Resolve check", exact: true })
      .click();
    await expect(pending.getByRole("alert").first()).toBeVisible();
    await expect(
      pending.getByLabel("Attempted action", { exact: false }),
    ).toHaveValue("Inspect the bell");
    await attribute.selectOption("focus");
    await pending
      .getByRole("button", { name: "Resolve check", exact: true })
      .click();
    await waitForTurnIdle(page);
    await expect(pending).toContainText("No pending interactions.");
    const messages = await page.request.get(
      `/api/sessions/${f.sessionId}/messages`,
      { headers: f.headers },
    );
    expect(JSON.stringify(await messages.json())).toContain("Inspect the bell");
  } finally {
    await f.close();
  }
});

test("changing views during deferred interruption keeps the second draft and admits one new request", async ({
  page,
}) => {
  const f = await prepareEnsemble(page, "host", false, ["codex"]);
  let releaseActor: () => void = () => {};
  let releaseAbort: () => void = () => {};
  const actorGate = new Promise<void>((resolve) => {
    releaseActor = resolve;
  });
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const sent: unknown[] = [];
  let actors = 0;
  try {
    await f.strategy("list");
    f.provider.reply = (request) =>
      ensembleReply(request, f.calls, false, () =>
        ++actors === 3 ? actorGate : undefined,
      );
    page.on("request", (request) => {
      if (request.url().endsWith("/api/actions") && request.method() === "POST")
        sent.push(request.postDataJSON());
    });
    await openView(page, "DM Console");
    await page.getByTestId("composer-mode-direct").click();
    await composerInput(page).fill("Mara and Ivo, begin the exchange.");
    await composerInput(page).press("Enter");
    await expect.poll(() => actors).toBe(3);
    await page.route(`**/api/sessions/${f.sessionId}/abort`, async (route) => {
      await abortGate;
      await route.continue();
    });
    const aborting = page.waitForRequest((request) =>
      request.url().endsWith(`/api/sessions/${f.sessionId}/abort`),
    );
    await composerInput(page).fill("Mara and Ivo, start a fresh exchange.");
    await composerInput(page).press("Enter");
    await aborting;
    await composerInput(page).fill("Keep this second direction");
    await composerInput(page).press("Enter");
    await expect(composerInput(page)).toHaveValue("Keep this second direction");
    await openView(page, "Codex");
    await expect(
      page
        .getByTestId("plugin-view-bar")
        .getByRole("button", { name: "Stop the current turn" }),
    ).toBeVisible();
    await back(page);
    await expect(composerInput(page)).toHaveValue("Keep this second direction");
    releaseAbort();
    releaseActor();
    await waitForTurnIdle(page);
    await expect.poll(() => sent.length).toBe(2);
    await expect(composerInput(page)).toHaveValue("Keep this second direction");
    await openView(page, "DM Console");
    await expect(composerInput(page)).toHaveValue("Keep this second direction");
    const messages = await page.request.get(
      `/api/sessions/${f.sessionId}/messages`,
      { headers: f.headers },
    );
    const saved = JSON.stringify(await messages.json());
    expect(saved).toContain("start a fresh exchange.");
    expect(saved).not.toContain("Keep this second direction");
  } finally {
    releaseAbort();
    releaseActor();
    await f.close();
  }
});
