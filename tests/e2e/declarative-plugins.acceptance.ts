import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFakeLlmProvider } from "./helpers/fake-llm-provider.js";
import {
  ONBOARDING_VERSION,
  openStudioConfiguration,
  closeStudioConfiguration,
  seedBrowserSettings,
  useServerWorlds,
} from "./helpers/player.js";

const pluginId = "declarative-notebook";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

test("a declarative community notebook commits without grants, retains content consent and quarantines a code upgrade", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const root: unknown = info.config.metadata.declarativeNotebookRoot;
  expect(typeof root).toBe("string");
  if (typeof root !== "string")
    throw new Error("Use the private community acceptance configuration");
  const script = path.join(root, "ui/page/app.js");
  const original = await readFile(script, "utf8");
  const sentinel = path.join(
    path.dirname(root),
    `notebook-imported-${crypto.randomUUID()}.txt`,
  );
  await expect(access(path.join(root, "server"))).rejects.toThrow();
  await expect(access(sentinel)).rejects.toThrow();
  const provider = await startFakeLlmProvider();
  provider.reply = (model) => ({
    text: "",
    toolCalls: [
      {
        id: "note",
        type: "function",
        function: {
          name: model.rawMessages.some((message) => message.role === "tool")
            ? "runtime-done"
            : "notes-upsert",
          arguments: JSON.stringify(
            model.rawMessages.some((message) => message.role === "tool")
              ? {}
              : { record: { id: "harbor", text: "We reached the harbor." } },
          ),
        },
      },
    ],
  });
  let sessionId: string | undefined;
  try {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    await useServerWorlds(page);
    const discovery = await request.get("/api/plugins");
    const { items } = await discovery.json();
    expect(items).toContainEqual(
      expect.objectContaining({
        id: pluginId,
        source: "community",
        executionMode: "declarative",
      }),
    );
    const created = await request.post("/api/sessions", {
      data: {
        locale: "en-US",
        plugins: [],
        excludedPlugins: items
          .filter((item: { source: string }) => item.source === "builtin")
          .map((item: { id: string }) => item.id),
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;
    const url = `/api/sessions/${sessionId}`;
    await page.goto(`/session?sid=${sessionId}`);
    await openStudioConfiguration(page);
    const toggle = page.getByRole("switch", {
      name: "Declarative notebook: Enable plugin",
      exact: true,
    });
    await expect(toggle).toBeVisible();
    const row = toggle.locator("..").locator("..");
    await expect(row.getByTestId("plugin-model-notice")).toContainText(
      "Uses your configured model; charges may apply.",
    );
    const enabled = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${url}/plugins/${pluginId}`) &&
        response.request().method() === "PUT",
    );
    await toggle.click();
    expect((await enabled).status()).toBe(200);
    await expect(page.getByRole("dialog", { name: /Authorize/ })).toHaveCount(
      0,
    );
    const approvals = async () =>
      (await (await request.get(`${url}/approvals`)).json()).items;
    expect(await approvals()).toEqual([]);
    await closeStudioConfiguration(page);
    const turn = await request.post("/api/actions", {
      headers: {
        "x-slot-config": encode({
          customPresets: [
            {
              id: "notebook-model",
              provider: "fake",
              model: "notebook",
              protocol: "openai-chat-v1",
              baseUrl: provider.baseUrl,
            },
          ],
          slotBindings: { plugin: { modelRef: "notebook-model" } },
        }),
        "x-provider-keys": encode({ fake: "test-key" }),
      },
      data: {
        requestId: crypto.randomUUID(),
        sessionId,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "We reached the harbor." }] },
      },
    });
    expect(turn.ok(), await turn.text()).toBe(true);
    expect(await turn.text()).toContain('"committed":true');
    expect(provider.requests.length).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await expect(
      page.getByRole("tabpanel", { name: "Notebook", exact: true }),
    ).toContainText("We reached the harbor.");
    expect(await approvals()).toEqual([]);
    const status = (
      await (await request.get(`${url}/plugins`)).json()
    ).items.find((item: { id: string }) => item.id === pluginId);
    expect(status).toMatchObject({
      active: true,
      executionMode: "declarative",
      serverCodeApproved: false,
      approvalRequired: false,
    });
    expect(status.serverCodeApprovedBy).toBeUndefined();

    await expect(
      page
        .locator('[data-role="user"]')
        .filter({ hasText: "We reached the harbor." }),
    ).toBeVisible();

    const openView = async () => {
      await page
        .getByRole("button", { name: "Plugin views", exact: true })
        .click();
      await page.getByRole("button", { name: /Notebook page/ }).click();
    };
    await openView();
    await expect(
      page.getByRole("dialog", { name: /Allow.*Notebook page/ }),
    ).toBeVisible();
    await expect(
      page.getByTestId("plugin-view-container").locator("iframe"),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Use default view", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Notebook", exact: true }),
    ).toBeVisible();
    await openView();
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    const container = page.getByTestId("plugin-view-container");
    await expect(container.locator("iframe")).toHaveAttribute(
      "src",
      /\/plugin-assets\/declarative-notebook\/[a-f0-9]{32}\/index\.html$/,
    );
    await expect(container.locator("iframe")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    const view = container.frameLocator("iframe");
    await expect(view.locator("#script-status")).toHaveText(
      "Notebook browser script loaded",
    );
    await expect(view.locator("#session-status")).toContainText(
      "We reached the harbor.",
    );
    await page
      .getByRole("button", { name: "View permissions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Revoke all page permissions", exact: true })
      .click();
    await expect(page.getByTestId("plugin-view-container")).toHaveCount(0);
    await openView();
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    await expect(view.locator("#script-status")).toHaveText(
      "Notebook browser script loaded",
    );

    // Update actual installed content, then use the supported development reload.
    await writeFile(
      script,
      original.replace(
        "Notebook browser script loaded",
        "Notebook browser script updated",
      ),
    );
    const reloaded = await request.post(`/api/plugins/${pluginId}/reload`, {
      data: { sessionId },
    });
    expect(reloaded.ok(), await reloaded.text()).toBe(true);
    await page.reload();
    await openView();
    await expect(
      page.getByRole("dialog", { name: /Allow.*Notebook page/ }),
    ).toBeVisible();
    await expect(
      page.getByTestId("plugin-view-container").locator("iframe"),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Allow requested capabilities",
        exact: true,
      })
      .click();
    await expect(view.locator("#script-status")).toHaveText(
      "Notebook browser script updated",
    );

    await mkdir(path.join(root, "server"));
    await writeFile(
      path.join(root, "server/index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "imported"); export default () => {};`,
    );
    const upgrade = await request.post(`/api/plugins/${pluginId}/reload`, {
      data: { sessionId },
    });
    expect(upgrade.ok(), await upgrade.text()).toBe(true);
    await expect(access(sentinel)).rejects.toThrow();
    const pending = await request.put(`${url}/plugins/${pluginId}`);
    expect(pending.status()).toBe(202);
    const { approvalId } = await pending.json();
    const queued = await approvals();
    expect(queued).toContainEqual(
      expect.objectContaining({ action: "covel:plugin-server-code" }),
    );
    await expect(access(sentinel)).rejects.toThrow();
    const granted = await request.post(
      `/api/approvals/${approvalId}/decision`,
      { data: { decision: "allow", scope: "session" } },
    );
    expect(granted.ok(), await granted.text()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("imported");
    // Runtime permission remains independent after server code is approved.
    const denied = await request.post("/api/actions", {
      data: {
        requestId: crypto.randomUUID(),
        sessionId,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "Wait" }] },
      },
    });
    expect(denied.status()).toBe(202);
    expect(await approvals()).toContainEqual(
      expect.objectContaining({ action: `runtime:${pluginId}` }),
    );
  } finally {
    try {
      if (!page.isClosed()) await page.goto("about:blank");
      if (sessionId) await request.delete(`/api/sessions/${sessionId}`);
    } finally {
      try {
        await rm(path.join(root, "server"), { recursive: true, force: true });
        await rm(sentinel, { force: true });
        await writeFile(script, original);
        // Publish the restored package in the same API process before another
        // test discovers it; file restoration alone leaves the code upgrade live.
        const restored = await request.post(`/api/plugins/${pluginId}/reload`);
        expect(restored.ok(), await restored.text()).toBe(true);
        const directory = await (await request.get("/api/plugins")).json();
        expect(
          directory.items.find((item: { id: string }) => item.id === pluginId),
        ).toMatchObject({ executionMode: "declarative" });
      } finally {
        await provider.close();
      }
    }
  }
});
