import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
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

test("ordinary session pages commit actions, interactions and own runtime writes with content-bound consent", async ({
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
    const choose = async (name = "Bridge reader") => {
      await page
        .getByRole("button", { name: "Plugin views", exact: true })
        .click();
      await page
        .getByRole("button", { name: new RegExp(`^${name}\\b`) })
        .click();
    };
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
      view.getByRole("heading", { name: "Session bridge probe", exact: true }),
    ).toBeVisible();
    await expect(view.locator("#input")).toContainText(
      '"currentCharacterId":"hero"',
    );
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
    await writeFile(script, original + "\n// Published content changed.\n");
    const reload = await request.post(`/api/plugins/${pluginId}/reload`, {
      data: { sessionId },
    });
    expect(reload.ok(), await reload.text()).toBe(true);
    await page.reload();
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
    await writeFile(script, original);
    if (sessionId) {
      await request.post(`/api/plugins/${pluginId}/reload`, {
        data: { sessionId },
      });
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
    await page
      .getByRole("button", { name: "Plugin views", exact: true })
      .click();
    await page.getByRole("button", { name: /^Bridge reader\b/ }).click();
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
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
    await page.unrouteAll({ behavior: "wait" });
    for (const id of sessions) await request.delete(`/api/sessions/${id}`);
  }
});
