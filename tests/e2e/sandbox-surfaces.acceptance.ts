import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  useServerWorlds,
} from "./helpers/player.js";

const pluginId = "sandbox-surface-probe";
async function approved(
  request: APIRequestContext,
  url: string,
  method: "post" | "put",
  data?: unknown,
) {
  for (let count = 0; count < 5; count++) {
    const response = await request[method](
      url,
      data === undefined ? {} : { data },
    );
    if (response.status() !== 202) return response;
    const pending = await response.json();
    const grant = await request.post(
      `/api/approvals/${pending.approvalId}/decision`,
      { data: { decision: "allow", scope: "session" } },
    );
    expect(grant.ok(), await grant.text()).toBe(true);
  }
  throw new Error("Approval did not settle");
}

async function selectMainView(page: Page) {
  await page.getByRole("button", { name: "Plugin views", exact: true }).click();
  const option = page.getByRole("button", { name: /^Bridge reader\b/ });
  await expect(option).toBeVisible();
  await expect
    .poll(
      () =>
        option.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
      {
        message:
          "The host view menu must remain clickable above surface controls",
      },
    )
    .toBe(true);
  await option.click();
}

async function probeContent(request: APIRequestContext, sessionId: string) {
  const response = await request.get(
    `/api/ui-specs?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const result = (await response.json()) as {
    view: {
      pluginId: string;
      specs: { id: string; webview?: { url?: string; html?: string } }[];
    }[];
  };
  const specs =
    result.view.find((entry) => entry.pluginId === pluginId)?.specs ?? [];
  const ready =
    specs.length === 2 &&
    ["reader", "input"].every((id) =>
      specs.some(
        (spec) =>
          spec.id === id &&
          (typeof spec.webview?.url === "string" ||
            typeof spec.webview?.html === "string"),
      ),
    );
  return {
    ready,
    signature: JSON.stringify(
      specs
        .map(({ id, webview }) => ({ id, webview }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  };
}

async function reloadProbe(
  request: APIRequestContext,
  sessionId: string,
  previousSignature?: string,
) {
  const response = await request.post(`/api/plugins/${pluginId}/reload`, {
    data: { sessionId },
  });
  expect(response.ok(), await response.text()).toBe(true);
  // Observe the published content rather than waiting for the development watcher.
  await expect
    .poll(async () => {
      const content = await probeContent(request, sessionId);
      return {
        ready: content.ready,
        changed:
          previousSignature === undefined ||
          content.signature !== previousSignature,
      };
    })
    .toEqual({ ready: true, changed: true });
}

test("session pages commit actions, interactions and own runtime writes with content-bound consent", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const root: unknown = info.config.metadata.sandboxProbeRoot;
  expect(typeof root).toBe("string");
  if (typeof root !== "string")
    throw new Error("Use the private community acceptance configuration");
  const script = path.join(root, "ui/app/app.js");
  const original = await readFile(script, "utf8");
  let sessionId: string | undefined;
  let scriptChanged = false;
  try {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await useServerWorlds(page);
    const directory = await (await request.get("/api/plugins")).json();
    const created = await request.post("/api/sessions", {
      data: {
        locale: "en-US",
        plugins: [],
        excludedPlugins: directory.items
          .filter((item: { source: string }) => item.source === "builtin")
          .map((item: { id: string }) => item.id),
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;
    const url = `/api/sessions/${sessionId}`;
    const enabled = await approved(
      request,
      `${url}/plugins/${pluginId}`,
      "put",
    );
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const character = await request.post(`${url}/characters`, {
      data: { id: "hero", name: "Hero", type: "player" },
    });
    expect(character.ok(), await character.text()).toBe(true);
    const opening = await request.post("/api/actions", {
      data: {
        requestId: crypto.randomUUID(),
        sessionId,
        type: "start_session",
        payload: {},
      },
    });
    expect(opening.ok(), await opening.text()).toBe(true);
    expect(await opening.text()).toContain('"committed":true');
    await page.goto(`/session?sid=${sessionId}`);
    const choose = () => selectMainView(page);
    await choose();
    const dialog = page.getByRole("dialog", { name: /Allow.*Bridge reader/ });
    await expect(dialog).toBeVisible();
    for (const label of [
      "Submit player actions",
      "Answer pending interactions",
      "Run this plugin’s manual runtimes",
      "Stop the current execution",
      "Open this plugin’s panels",
    ])
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(
      page.getByTestId("plugin-view-container").locator("iframe"),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Use default view", exact: true })
      .click();
    await choose();
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    const view = page
      .getByTestId("plugin-view-container")
      .frameLocator("iframe");
    await expect(
      page.getByTestId("plugin-view-container").locator("[data-page-status]"),
    ).toHaveAttribute("data-page-status", "ready");
    await expect(
      view.getByRole("heading", { name: "Session bridge probe", exact: true }),
    ).toBeVisible();
    await expect(view.locator("#input")).toContainText(
      '"currentCharacterId":"hero"',
    );
    await expect(view.locator("#input")).toContainText('"say"');
    await view.getByLabel("Player action").fill("Open the gate");
    await view
      .getByRole("button", { name: "Submit action", exact: true })
      .click();
    await expect(view.locator("#outcome")).toContainText('"status":"accepted"');
    await expect
      .poll(
        async () =>
          (await (await request.get(`${url}/messages`)).json()).items.filter(
            (row: { content: string }) => row.content === "Open the gate",
          ).length,
      )
      .toBe(1);
    const messages = (await (await request.get(`${url}/messages`)).json())
      .items;
    expect(
      messages.find(
        (row: { content: string }) => row.content === "Open the gate",
      ),
    ).toMatchObject({
      actions: [{ source: "player", seatId: "main", actorId: "hero" }],
    });
    await view.getByRole("button", { name: "Write note", exact: true }).click();
    const approval = page.getByRole("dialog", { name: /Authorize/ });
    await expect(approval).toBeVisible();
    await approval.getByRole("button", { name: /Allow|Authorize/ }).click();
    await expect(view.locator("#outcome")).toContainText(
      '"status":"committed"',
    );
    const notes = await (
      await request.get(`${url}/plugin-data/${pluginId}/notes`)
    ).json();
    expect(notes.items).toContainEqual(
      expect.objectContaining({
        value: { id: "bridge", text: "Written from the sandbox" },
      }),
    );
    await view.getByRole("button", { name: "Ask form", exact: true }).click();
    await expect(view.getByLabel("Route", { exact: true })).toBeVisible();
    await view.getByLabel("Route", { exact: true }).fill("Left");
    await view
      .getByRole("button", { name: "Answer route", exact: true })
      .click();
    await expect
      .poll(async () =>
        JSON.stringify(await (await request.get(`${url}/view`)).json()),
      )
      .toContain("Left");
    await view.getByRole("button", { name: "Open notes", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Bridge notes", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await view
      .getByRole("button", { name: "Stop execution", exact: true })
      .click();
    await expect(view.locator("#outcome")).toContainText('"status":"accepted"');
    const frame = page
      .frames()
      .find((frame) => frame.url().includes(`/plugin-assets/${pluginId}/`));
    expect(frame).toBeDefined();
    await expect(
      view.getByRole("img", { name: "Local resource loaded" }),
    ).toBeVisible();
    expect(
      await view
        .getByRole("img", { name: "Local resource loaded" })
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    expect(
      await frame!.evaluate(async () => {
        try {
          await fetch("/api/sessions");
          return "allowed";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");
    expect(
      await frame!.evaluate(() => {
        try {
          void window.top!.document.body;
          return "allowed";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");
    const state = await frame!.evaluate(() => {
      const host = window as unknown as {
        covel: { getState(): unknown };
        covelIpc?: unknown;
        require?: unknown;
      };
      let storage = false;
      try {
        localStorage.getItem("probe");
        storage = true;
      } catch {}
      return {
        state: host.covel.getState(),
        storage,
        ipc: typeof host.covelIpc,
        node: typeof host.require,
        origin: location.origin,
      };
    });
    expect(state.storage).toBe(false);
    expect(state.ipc).toBe("undefined");
    expect(state.node).toBe("undefined");
    for (const sentinel of [
      "bridge-private-result",
      "providerContinuation",
      "context",
      "jobs",
      "_hidden",
    ])
      expect(JSON.stringify(state.state)).not.toContain(sentinel);
    await page.reload();
    await choose();
    await expect(
      page.getByRole("dialog", { name: /Allow.*Bridge reader/ }),
    ).toHaveCount(0);
    await expect(
      view.getByRole("heading", { name: "Session bridge probe", exact: true }),
    ).toBeVisible();
    const previous = await probeContent(request, sessionId);
    expect(previous.ready).toBe(true);
    await page.goto("about:blank");
    scriptChanged = true;
    await writeFile(script, original + "\n// Published content changed.\n");
    await reloadProbe(request, sessionId, previous.signature);
    await page.goto(`/session?sid=${sessionId}`);
    await choose();
    await expect(
      page.getByRole("dialog", { name: /Allow.*Bridge reader/ }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "View permissions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Revoke all page permissions", exact: true })
      .click();
    await expect(page.getByTestId("plugin-view-container")).toHaveCount(0);
  } finally {
    if (!page.isClosed()) await page.goto("about:blank");
    if (scriptChanged) await writeFile(script, original);
    if (sessionId && !page.isClosed()) {
      if (scriptChanged) await reloadProbe(request, sessionId);
      await request.delete(`/api/sessions/${sessionId}`);
    }
  }
});

test("a delayed runtime approval from a retired session page cannot dispatch in a new visit", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const sessions: string[] = [];
  let release!: () => void;
  let reached!: () => void;
  let settled!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  try {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await useServerWorlds(page);
    const directory = await (await request.get("/api/plugins")).json();
    for (let index = 0; index < 2; index++) {
      const created = await request.post("/api/sessions", {
        data: {
          locale: "en-US",
          plugins: [],
          excludedPlugins: directory.items
            .filter((item: { source: string }) => item.source === "builtin")
            .map((item: { id: string }) => item.id),
        },
      });
      expect(created.status()).toBe(201);
      const id: string = (await created.json()).id;
      sessions.push(id);
      expect(
        (
          await approved(
            request,
            `/api/sessions/${id}/plugins/${pluginId}`,
            "put",
          )
        ).ok(),
      ).toBe(true);
    }
    const [source, destination] = sessions;
    await page.goto(`/session?sid=${source}`);
    await selectMainView(page);
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    await expect(
      page.getByTestId("plugin-view-container").locator("[data-page-status]"),
    ).toHaveAttribute("data-page-status", "ready");
    const mask = `**/api/sessions/${source}/plugin-rpc`;
    await page.route(mask, async (route) => {
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        reached();
        await gate;
        await route.fulfill({ response }).catch(() => {});
      } finally {
        settled();
      }
    });
    await page
      .getByTestId("plugin-view-container")
      .frameLocator("iframe")
      .getByRole("button", { name: "Write note", exact: true })
      .click();
    await ready;
    await page.goto(`/session?sid=${destination}`);
    release();
    await done;
    await page.unroute(mask);
    await expect(page.getByRole("dialog", { name: /Authorize/ })).toHaveCount(
      0,
    );
    for (const id of sessions) {
      const notes = await (
        await request.get(`/api/sessions/${id}/plugin-data/${pluginId}/notes`)
      ).json();
      expect(notes.items).toEqual([]);
    }
  } finally {
    release();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      for (const id of sessions) await request.delete(`/api/sessions/${id}`);
    }
  }
});

for (const width of [1280, 360]) {
  test(`independent sandbox regions preserve host hit targets and recover at ${width}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await useServerWorlds(page);
    const directory = await (await request.get("/api/plugins")).json();
    const created = await request.post("/api/sessions", {
      data: {
        locale: "en-US",
        plugins: [],
        excludedPlugins: directory.items
          .filter((item: { source: string }) => item.source === "builtin")
          .map((item: { id: string }) => item.id),
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const sessionId: string = (await created.json()).id;
    const url = `/api/sessions/${sessionId}`;
    let releaseAction = () => {};
    try {
      expect(
        (await approved(request, `${url}/plugins/${pluginId}`, "put")).ok(),
      ).toBe(true);
      expect(
        (
          await request.post(`${url}/characters`, {
            data: { id: "hero", name: "Hero", type: "player" },
          })
        ).ok(),
      ).toBe(true);
      const opened = await request.post("/api/actions", {
        data: {
          requestId: crypto.randomUUID(),
          sessionId,
          type: "start_session",
          payload: {},
        },
      });
      expect(await opened.text()).toContain('"committed":true');
      await page.goto(`/session?sid=${sessionId}`);
      const main = page.getByRole("region", {
        name: "Bridge reader",
        exact: true,
      });
      const input = page.getByRole("region", {
        name: "Bridge input",
        exact: true,
      });
      const controls = page.getByTestId("sandbox-surface-controls");
      const selectMain = () => selectMainView(page);
      const selectInput = () =>
        controls
          .getByRole("combobox", { name: "Composer", exact: true })
          .selectOption(`plugin:${pluginId}:input`);
      const allow = async () => {
        await page
          .getByRole("dialog")
          .getByRole("button", {
            name: "Allow requested capabilities",
            exact: true,
          })
          .click();
      };
      const mainPage = main.frameLocator("iframe");
      const inputPage = input.frameLocator("iframe");
      await selectMain();
      await allow();
      await expect(main.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(mainPage.locator("#draft")).toBeVisible();
      await expect(
        page.getByRole("combobox", {
          name: "Story input — press Enter to send",
          exact: true,
        }),
      ).toBeVisible();
      await selectInput();
      await allow();
      await expect(input.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(inputPage.locator("#draft")).toBeVisible();
      await expect(
        page.getByRole("combobox", {
          name: "Story input — press Enter to send",
          exact: true,
        }),
      ).toHaveCount(0);
      await mainPage
        .getByRole("button", { name: "Fill viewport", exact: true })
        .click();
      await inputPage
        .getByRole("button", { name: "Fill viewport", exact: true })
        .click();
      const scrollsInsideFrame = await inputPage
        .locator("body")
        .evaluate((body) => {
          const before = body.scrollTop;
          body.scrollTop = before + 1;
          const moved = body.scrollTop > before;
          body.scrollTop = before;
          return moved;
        });
      expect(
        scrollsInsideFrame,
        "The fixed probe body must scroll so its action controls remain reachable",
      ).toBe(true);
      const back = controls.getByRole("button", {
        name: "Back to default interface",
        exact: true,
      });
      const assertHitTarget = async (target: typeof back) => {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        if (!box) throw new Error("Host control has no geometry");
        expect(box.width).toBeGreaterThan(20);
        expect(box.height).toBeGreaterThan(20);
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        expect(
          await target.evaluate(
            (element, point) =>
              element.contains(document.elementFromPoint(point.x, point.y)),
            point,
          ),
        ).toBe(true);
        return point;
      };
      const mainBox = await main.locator("iframe").boundingBox();
      const inputBox = await input.locator("iframe").boundingBox();
      const stripBox = await controls.boundingBox();
      expect(mainBox && inputBox && stripBox).toBeTruthy();
      expect(mainBox!.y).toBeGreaterThanOrEqual(stripBox!.y + stripBox!.height);
      expect(inputBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height);
      await assertHitTarget(back);
      const isolation = await inputPage.locator("body").evaluate(async () => {
        const host = window as Window & {
          covelIpc?: unknown;
          require?: unknown;
        };
        let storage = false,
          parentDom = false,
          topNavigation = false,
          cookies = false;
        try {
          localStorage.getItem("probe");
          storage = true;
        } catch {}
        try {
          void parent.document.body;
          parentDom = true;
        } catch {}
        try {
          top!.location.href = "about:blank";
          topNavigation = true;
        } catch {}
        try {
          void document.cookie;
          cookies = true;
        } catch {}
        const api = await fetch("/api/health").then(
          () => true,
          () => false,
        );
        return {
          storage,
          parentDom,
          topNavigation,
          cookies,
          api,
          ipc: typeof host.covelIpc,
          node: typeof host.require,
          sandbox: location.origin,
        };
      });
      expect(isolation.storage).toBe(false);
      expect(isolation.parentDom).toBe(false);
      expect(isolation.topNavigation).toBe(false);
      expect(isolation.cookies).toBe(false);
      expect(isolation.api).toBe(false);
      expect(isolation.ipc).toBe("undefined");
      expect(isolation.node).toBe("undefined");
      await expect(input.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      await expect(inputPage.locator("img")).toHaveJSProperty("complete", true);
      expect(
        await inputPage
          .locator("img")
          .evaluate((element: HTMLImageElement) => element.naturalWidth),
      ).toBeGreaterThan(0);

      // Gate a normal player request so host Stop/return are exercised during execution.
      const actionGate = new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      await page.route("**/api/actions", async (route) => {
        await actionGate;
        await route.continue().catch(() => {});
      });
      await expect(inputPage.locator("#input")).toContainText('"say"');
      await inputPage.getByLabel("Player action").fill("A held player action");
      await inputPage
        .getByRole("button", { name: "Submit action", exact: true })
        .click();
      const stop = controls.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible();
      const stopPoint = await assertHitTarget(stop);
      await page.mouse.click(stopPoint.x, stopPoint.y);
      releaseAction();
      await page.unroute("**/api/actions");
      await controls
        .getByRole("combobox", { name: "Composer", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      await expect(back).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(main).toHaveCount(0);
      await expect(input).toHaveCount(0);

      await selectMain();
      await expect(
        page.getByRole("dialog", { name: /Allow.*Bridge reader/ }),
      ).toHaveCount(0);
      await selectInput();
      await expect(input.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(inputPage.locator("#draft")).toBeVisible();
      await inputPage
        .getByRole("button", { name: "Page error", exact: true })
        .click();
      await expect(input).toHaveCount(0);
      await expect(mainPage.locator("#draft")).toBeVisible();
      await expect(controls.getByRole("status")).toContainText("Bridge input");
      await controls
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await expect(input.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(inputPage.locator("#draft")).toBeVisible();
      await inputPage
        .getByRole("button", { name: "Ignore heartbeat", exact: true })
        .click();
      // Keep the running clock that owns the ready page's heartbeat timer.
      await expect(input).toHaveCount(0, { timeout: 25_000 });
      await expect(controls.getByRole("status")).toContainText("Bridge input");
      await expect(mainPage.locator("#draft")).toBeVisible();
      await controls
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await expect(input.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(inputPage.locator("#draft")).toBeVisible();
      await inputPage
        .getByRole("button", { name: "Navigate", exact: true })
        .click();
      await expect(input).toHaveCount(0);
      await expect(mainPage.locator("#draft")).toBeVisible();

      let releasePage!: () => void;
      const pageGate = new Promise<void>((resolve) => {
        releasePage = resolve;
      });
      await page.route("**/plugin-assets/**/index.html", async (route) => {
        await pageGate;
        await route.abort().catch(() => {});
      });
      try {
        await controls
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await expect(input).toBeVisible();
        await expect(input.locator("[data-page-status]")).toHaveAttribute(
          "data-page-status",
          "loading",
        );
        await expect(input).toHaveCount(0, { timeout: 12_000 });
        await expect(controls.getByRole("status")).toContainText(
          "Bridge input",
        );
        await expect(mainPage.locator("#draft")).toBeVisible();
      } finally {
        releasePage();
        await page.unroute("**/plugin-assets/**/index.html");
      }
      await back.click();
      await page
        .getByRole("button", { name: "Stage view", exact: true })
        .click();
      await selectInput();
      await expect(input.locator("[data-page-status]")).toHaveAttribute(
        "data-page-status",
        "ready",
      );
      await expect(inputPage.locator("#draft")).toBeVisible();
      await expect(page.getByTestId("stage-decision-input")).toHaveCount(0);
      // The stage's immersion toggle leaves the protected global strip visible.
      await page.getByTestId("stage-immersive-toggle").click();
      await expect(page.getByTestId("stage-immersive-toggle")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const point = await assertHitTarget(back);
      await page.mouse.click(point.x, point.y);
      await expect(input).toHaveCount(0);
    } finally {
      releaseAction();
      if (!page.isClosed()) {
        await page.unrouteAll({ behavior: "wait" });
        await request.delete(url);
      }
    }
  });
}

test("inline composer uses the same ready, error and opaque-origin recovery contract", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const root: unknown = info.config.metadata.sandboxProbeRoot;
  if (typeof root !== "string")
    throw new Error("Use the private community acceptance configuration");
  const specPath = path.join(root, "ui/input.json");
  const inlinePath = path.join(root, "ui/inline.html");
  const original = await readFile(specPath, "utf8");
  const html = await readFile(path.join(root, "ui/app/index.html"), "utf8");
  const js = await readFile(path.join(root, "ui/app/app.js"), "utf8");
  const css = await readFile(path.join(root, "ui/app/app.css"), "utf8");
  const image = await readFile(path.join(root, "ui/app/probe.svg"));
  const spec = JSON.parse(original);
  let sessionId: string | undefined;
  let releasePage = () => {};
  let contentChanged = false;
  try {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await useServerWorlds(page);
    const directory = await (await request.get("/api/plugins")).json();
    const created = await request.post("/api/sessions", {
      data: {
        locale: "en-US",
        plugins: [],
        excludedPlugins: directory.items
          .filter((item: { source: string }) => item.source === "builtin")
          .map((item: { id: string }) => item.id),
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;
    const url = `/api/sessions/${sessionId}`;
    expect(
      (await approved(request, `${url}/plugins/${pluginId}`, "put")).ok(),
    ).toBe(true);
    const previous = await probeContent(request, sessionId);
    expect(previous.ready).toBe(true);
    contentChanged = true;
    await writeFile(
      inlinePath,
      html
        .replace(
          '<link rel="stylesheet" href="app.css" />',
          `<style>${css}</style>`,
        )
        .replace('<script defer src="app.js"></script>', "")
        .replace("</body>", `<script>${js}</script></body>`)
        .replace(
          'src="probe.svg"',
          `src="data:image/svg+xml;base64,${image.toString("base64")}"`,
        ),
    );
    await writeFile(
      specPath,
      JSON.stringify({ ...spec, webview: { entry: "./inline.html" } }),
    );
    await reloadProbe(request, sessionId, previous.signature);
    await page.goto(`/session?sid=${sessionId}`);
    const gate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await page.route("**/plugin-frame.html", async (route) => {
      await gate;
      await route.abort().catch(() => {});
    });
    const controls = page.getByTestId("sandbox-surface-controls");
    await controls
      .getByRole("combobox", { name: "Composer", exact: true })
      .selectOption(`plugin:${pluginId}:input`);
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    await expect(controls.getByRole("status")).toContainText("Bridge input", {
      timeout: 12_000,
    });
    await expect(page.getByTestId("sandbox-composer")).toHaveCount(0);
    releasePage();
    await page.unroute("**/plugin-frame.html");
    await controls.getByRole("button", { name: "Retry", exact: true }).click();
    const outer = page.getByTestId("sandbox-composer").locator("iframe");
    const inner = page
      .getByTestId("sandbox-composer")
      .frameLocator("iframe")
      .frameLocator("iframe");
    await expect(inner.locator("#draft")).toBeVisible();
    await expect(outer).toHaveAttribute("sandbox", "allow-scripts");
    const isolated = await inner.locator("body").evaluate(async () => {
      const host = window as Window & { require?: unknown; covelIpc?: unknown };
      let storage = false,
        parentDom = false,
        topNavigation = false,
        cookies = false;
      try {
        localStorage.getItem("probe");
        storage = true;
      } catch {}
      try {
        void parent.document.body;
        parentDom = true;
      } catch {}
      try {
        top!.location.href = "about:blank";
        topNavigation = true;
      } catch {}
      try {
        void document.cookie;
        cookies = true;
      } catch {}
      const api = await fetch("/api/health").then(
        () => true,
        () => false,
      );
      return {
        storage,
        parentDom,
        topNavigation,
        cookies,
        api,
        node: typeof host.require,
        ipc: typeof host.covelIpc,
      };
    });
    expect(isolated).toEqual({
      storage: false,
      parentDom: false,
      topNavigation: false,
      cookies: false,
      api: false,
      node: "undefined",
      ipc: "undefined",
    });
    await inner
      .getByRole("button", { name: "Rejected promise", exact: true })
      .click();
    await expect(page.getByTestId("sandbox-composer")).toHaveCount(0);
    await expect(controls.getByRole("status")).toContainText("Bridge input");
    await controls
      .getByRole("button", { name: "Back to default interface", exact: true })
      .click();
    await expect(controls.getByRole("status")).toHaveCount(0);
  } finally {
    releasePage();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.goto("about:blank");
    }
    if (contentChanged) {
      await writeFile(specPath, original);
      await rm(inlinePath, { force: true });
    }
    if (sessionId && !page.isClosed()) {
      if (contentChanged) await reloadProbe(request, sessionId);
      await request.delete(`/api/sessions/${sessionId}`);
    }
  }
});
