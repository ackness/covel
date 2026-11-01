import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expect,
  test,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_PAGE_READY_TIMEOUT_MS,
} from "@covel/shared";
import { startStageRenderHost } from "../../apps/server/tests/helpers/stage-render-browser.js";
import { buildThirdPartyPluginZip } from "../../apps/server/tests/helpers/third-party-package.js";
import {
  composerInput,
  seedAppSettings,
  waitForTurnIdle,
} from "./helpers/player.js";
import {
  sandboxThemeFixture,
  startThemeOrchestrationHost,
  streamingThemeStory,
  themeSecrets,
} from "./helpers/theme-orchestration.js";

const fixture = resolve(import.meta.dirname, "../third-party/theme-pack-probe");
const pluginId = "theme-pack-probe";
type Host = Awaited<ReturnType<typeof startStageRenderHost>>;
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

async function upload(host: Host, root = fixture) {
  const zip = await buildThirdPartyPluginZip(root);
  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(zip)], { type: "application/zip" }),
    "theme-pack-probe.zip",
  );
  return fetch(`${host.baseUrl}/api/install/plugin`, { method: "POST", body });
}
async function api(host: Host, path: string, method = "GET", data?: unknown) {
  const response = await fetch(`${host.baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}
async function enable(host: Host, sessionId = host.sessionId) {
  const response = await api(
    host,
    `/api/sessions/${sessionId}/plugins/${pluginId}`,
    "PUT",
  );
  expect(response.status).toBe(200);
}
async function connect(page: Page, host: Host) {
  await seedAppSettings(page);
  const health = await api(host, "/api/health").then((response) =>
    response.json(),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config/info")
      return route.fulfill({ json: { isDesktop: false } });
    if (url.pathname === "/api/health")
      return route.fulfill({
        json: {
          ...health,
          storage: {
            ...health.storage,
            data: { ...health.storage?.data, frontendMode: "remote" },
          },
        },
      });
    return route.continue({
      url: `${host.baseUrl}${url.pathname}${url.search}`,
    });
  });
  // Retain the app origin for the page's unmodified frame-ancestors policy.
  await page.route("**/plugin-assets/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${host.baseUrl}${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
}
async function visit(page: Page, sessionId: string) {
  const ready = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ui-specs" &&
      response.url().includes(sessionId) &&
      response.ok(),
  );
  await page.goto(`/session?sid=${sessionId}`);
  await ready;
  await expect(composerInput(page)).toBeVisible();
  // Recovery keeps the visible composer executing until the session is ready.
  // Sending before it settles would submit an interjection instead of a turn.
  await waitForTurnIdle(page);
  await expect(composerInput(page)).toBeEnabled();
}
async function select(page: Page) {
  const trigger = page.getByRole("button", { name: "会话主题", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const picker = page.getByRole("combobox", { name: "会话主题", exact: true });
  await expect(picker).toBeEnabled();
  const option = picker.getByRole("option", {
    name: /阅读室.*theme-pack-probe/,
  });
  await picker.selectOption((await option.getAttribute("value")) ?? "");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(1);
  await expect(page.getByTestId("session-recovery-controls")).toBeVisible();
  // Applying can blur the disabled Apply button and close its menu. Escape
  // leaves it closed in either state; another toggle could reopen it.
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}
async function themeIdentity(host: Host, sessionId = host.sessionId) {
  const body = await api(host, `/api/ui-specs?sessionId=${sessionId}`).then(
    (r) => r.json(),
  );
  const theme = body.theme.find(
    (entry: { pluginId: string }) => entry.pluginId === pluginId,
  )?.specs[0];
  expect(theme).toBeDefined();
  return theme;
}
async function controlStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const s = getComputedStyle(element),
      r = element.getBoundingClientRect();
    return {
      color: s.color,
      background: s.backgroundColor,
      opacity: s.opacity,
      display: s.display,
      visibility: s.visibility,
      font: s.font,
      transform: s.transform,
      outline: s.outline,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  });
}
async function hit(locator: Locator) {
  await expect(locator).toBeVisible();
  // Visibility can precede Radix's modal layer registration: the body and
  // dialog still reject pointers until its effects enable the current layer.
  // Also wait for the dialog's own entrance motion before measuring its center.
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          const dialog = element.closest('[role="dialog"]');
          return (
            !dialog ||
            (getComputedStyle(element).pointerEvents !== "none" &&
              getComputedStyle(dialog).pointerEvents !== "none" &&
              dialog
                .getAnimations()
                .every(
                  (animation) =>
                    animation.playState === "finished" ||
                    animation.playState === "idle",
                ))
          );
        }),
      { message: "Dialog control finishes opening and accepts pointer events" },
    )
    .toBe(true);
  const report = await locator.evaluate((element) => {
    const describe = (node: Element | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName,
        id: node.id,
        class: node.getAttribute("class"),
        label: node.getAttribute("aria-label"),
        testId: node.getAttribute("data-testid"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    };
    const ancestors = (node: Element | null) => {
      const result = [];
      for (
        let count = 0;
        node && count < 12;
        count++, node = node.parentElement
      )
        result.push(describe(node));
      return result;
    };
    const r = element.getBoundingClientRect();
    const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const target = document.elementFromPoint(center.x, center.y);
    return {
      receivesPointer: target !== null && element.contains(target),
      center,
      control: describe(element),
      hitTarget: describe(target),
      controlAncestors: ancestors(element.parentElement),
      hitAncestors: ancestors(target?.parentElement ?? null),
    };
  });
  if (!report.receivesPointer)
    await test.info().attach("host-control-hit-test", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  expect(report.receivesPointer, JSON.stringify(report, null, 2)).toBe(true);
  expect(
    await locator.evaluate((element) =>
      element.closest("[data-covel-theme-part]"),
    ),
  ).toBeNull();
}
async function close(page: Page, host: Host) {
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "wait" });
  await host.close();
}

async function chooseSandboxReader(page: Page) {
  await page.getByRole("button", { name: "插件视图", exact: true }).click();
  const option = page.getByRole("button", { name: /^Bridge reader\b/ });
  await hit(option);
  await option.click();
}

async function allowSandbox(page: Page) {
  const consent = page.getByRole("dialog");
  const allow = consent.getByRole("button", {
    name: "允许所请求的能力",
    exact: true,
  });
  await hit(allow);
  await allow.click();
  await expect(consent).toBeHidden();
}

async function expectSandboxStory(region: Locator, story: string) {
  const iframe = region.locator("iframe");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute(
    "src",
    /^\/plugin-assets\/sandbox-surface-probe\/[a-f0-9]{32}\/index\.html$/,
  );
  const entry = await iframe.getAttribute("src");
  const element = await iframe.elementHandle();
  const frame = await element?.contentFrame();
  if (!frame || !entry) throw new Error("Selected sandbox frame is missing");
  // A selected region can exist before its new document has loaded. Bind to
  // that region's frame, then await navigation and its port acknowledgement.
  await frame.waitForURL((url) => url.pathname === entry, {
    waitUntil: "load",
    timeout: PLUGIN_PAGE_READY_TIMEOUT_MS,
  });
  await expect(region.locator("[data-page-status]")).toHaveAttribute(
    "data-page-status",
    "ready",
    { timeout: PLUGIN_PAGE_READY_TIMEOUT_MS },
  );
  const renderedStory = frame.locator("#story");
  await expect(renderedStory).toContainText(story);
  await expect(renderedStory).toBeVisible();
  return frame;
}

type PortEnvelope = {
  type: string;
  append?: string;
  value?: {
    theme?: { id: string; tokens: { background: string } };
    session?: {
      turn: number;
      executing: boolean;
      streaming: { text: string } | null;
    };
  };
};
async function portMessages(frame: Frame): Promise<PortEnvelope[]> {
  return frame.evaluate(
    () =>
      (window as Window & { themePortMessages?: PortEnvelope[] })
        .themePortMessages ?? [],
  );
}

async function observeSandboxPort(page: Page) {
  await page.addInitScript(() => {
    const envelopes: unknown[] = [];
    Object.assign(window, { themePortMessages: envelopes });
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "covel:connect") return;
      // Observe the transferred page port, including envelopes the page UI ignores.
      const port = event.ports[0];
      port?.addEventListener("message", (message) => {
        envelopes.push(message.data);
      });
    });
  });
}

async function assertPrivateThemeDataAbsent(
  page: Page,
  host: Host,
  frame: Frame,
) {
  const discovery = await api(
    host,
    `/api/ui-specs?sessionId=${host.sessionId}`,
  ).then((response) => response.text());
  const port = JSON.stringify(await portMessages(frame));
  for (const secret of themeSecrets) {
    expect(discovery).not.toContain(secret);
    expect(port).not.toContain(secret);
    await expect(page.locator("body")).not.toContainText(secret);
    await expect(frame.locator("body")).not.toContainText(secret);
  }
  for (const field of [
    "cssText",
    "assets",
    "ui.sessionTheme.",
    "ui.pluginViewConsent.",
    "providerContinuation",
    "reasoningContent",
    "_hidden",
  ])
    expect(port).not.toContain(field);
}

test("installed community palette, texture and session layout survive hydration and require explicit selection after updates", async ({
  page,
}) => {
  const host = await startStageRenderHost({
    narration: "Public reading theme story.",
    plugins: ["dm-console"],
  });
  const temp = await mkdtemp(join(tmpdir(), "theme-update-"));
  try {
    const install = await upload(host);
    expect(install.status).toBe(201);
    expect(await install.json()).toMatchObject({
      hasServerCode: false,
      restartRequired: true,
    });
    await host.restart();
    await enable(host);
    await connect(page, host);
    await visit(page, host.sessionId);
    await composerInput(page).fill("Tell the public story");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    await expect(
      page.getByText("Public reading theme story.", { exact: true }),
    ).toBeVisible();
    expect(await page.locator("style[data-plugin-theme-style]").count()).toBe(
      0,
    );
    const settings = page
      .getByTestId("center-panel")
      .locator(".ui-session-header")
      .getByRole("button", { name: "设置", exact: true });
    const before = await controlStyle(settings);
    await select(page);
    const story = page
      .locator('[data-covel-theme-part="story"]')
      .filter({ hasText: "Public reading theme story." });
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    await expect(page.locator("html")).toHaveAttribute("data-nav", "rail");
    await expect(page.locator("html")).toHaveAttribute(
      "data-world-list",
      "cards",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-backdrop",
      "banner",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-turn-notes",
      "margin",
    );
    const identity = await themeIdentity(host);
    const texture = `/plugin-assets/${pluginId}/${identity.assets.digest}/paper.png`;
    await expect(page.locator('[data-covel-theme-part="surface"]')).toHaveCSS(
      "background-image",
      new RegExp(identity.assets.digest),
    );
    const image = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image.naturalWidth;
    }, texture);
    expect(image).toBeGreaterThan(0);
    const after = await controlStyle(settings);
    expect(after).toEqual(before);
    await hit(settings);
    await settings.click();
    const appearance = page.getByRole("dialog");
    await appearance.getByRole("button", { name: "外观", exact: true }).click();
    const bodyColor = appearance
      .getByRole("textbox", { name: "正文颜色", exact: true })
      .and(appearance.locator('input[type="text"]'));
    await bodyColor.fill("#aabbcc");
    await bodyColor.press("Tab");
    await expect(story).toHaveCSS("color", "rgb(170, 187, 204)");
    await appearance
      .getByRole("group", { name: "颜色模式", exact: true })
      .getByRole("button", { name: "亮色", exact: true })
      .click();
    await expect(story).toHaveCSS("color", "rgb(48, 40, 24)");
    await appearance
      .getByRole("group", { name: "颜色模式", exact: true })
      .getByRole("button", { name: "暗色", exact: true })
      .click();
    await expect(story).toHaveCSS("color", "rgb(170, 187, 204)");
    await appearance
      .getByRole("button", { name: "恢复主题默认值", exact: true })
      .and(appearance.locator("button:enabled"))
      .first()
      .click();
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    await appearance
      .locator(".ui-style-card")
      .filter({ hasText: "书卷" })
      .getByRole("button")
      .first()
      .click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-world-list",
      "list",
    );
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    await appearance
      .locator(".ui-style-card")
      .filter({ hasText: "面板" })
      .getByRole("button")
      .first()
      .click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-world-list",
      "cards",
    );
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    const other = await api(host, "/api/sessions", "POST", {
      worldId: "stage-world",
      plugins: ["story-probe", pluginId],
      locale: "en-US",
      autoAdvanceLimit: 0,
    }).then((r) => r.json());
    await host.store.updateSession(other.id, { phase: "playing" });
    await visit(page, other.id);
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    await visit(page, host.sessionId);
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    await api(
      host,
      `/api/sessions/${host.sessionId}/plugins/${pluginId}`,
      "DELETE",
    );
    await page.reload();
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    await enable(host);
    await page.reload();
    await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
    await api(host, `/api/plugins/${pluginId}`, "DELETE");
    await host.restart();
    await page.reload();
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    const updated = join(temp, pluginId);
    await cp(fixture, updated, { recursive: true });
    const descriptor = join(updated, "ui/reading-theme.json");
    await writeFile(
      descriptor,
      (await readFile(descriptor, "utf8")).replace("#f5ead2", "#edd8bb"),
    );
    await writeFile(
      join(updated, "ui/reading-assets/paper.png"),
      Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200efa2a75b0000000049454e44ae426082",
        "hex",
      ),
    );
    expect((await upload(host, updated)).status).toBe(201);
    await host.restart();
    await enable(host);
    await page.reload();
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    expect((await fetch(`${host.baseUrl}${texture}`)).status).toBe(404);
    await select(page);
    await expect(story).toHaveCSS("color", "rgb(237, 216, 187)");
    const reset = page.getByRole("button", {
      name: "使用默认外观",
      exact: true,
    });
    await hit(reset);
    await reset.focus();
    expect(
      await reset.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      }),
    ).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-backdrop", "none");
    await page.reload();
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
  } finally {
    await close(page, host);
    await rm(temp, { recursive: true, force: true });
  }
});

test("sandbox consent preserves the frame element and asset policy at 360px with an active theme", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const host = await startStageRenderHost({
    narration: "Public reading theme story.",
    fixturePlugins: [sandboxThemeFixture],
  });
  try {
    expect((await upload(host)).status).toBe(201);
    await host.restart();
    await enable(host);
    await connect(page, host);
    await page.setViewportSize({ width: 360, height: 900 });
    await visit(page, host.sessionId);
    await composerInput(page).fill("Tell the public story");
    await composerInput(page).press("Enter");
    await expect(page.getByTestId("story-segments")).toContainText(
      "Public reading theme story.",
    );
    await waitForTurnIdle(page);
    await select(page);
    await expect(
      page
        .locator('[data-covel-theme-part="story"]')
        .filter({ hasText: "Public reading theme story." }),
    ).toHaveCSS("color", "rgb(245, 234, 210)");
    await chooseSandboxReader(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByTestId("plugin-view-container").locator("iframe"),
    ).toHaveCount(0);
    const lifetime = await page.evaluateHandle(() => {
      const center = document.querySelector('[data-testid="center-panel"]');
      if (!center) throw new Error("Session center is missing");
      const frames = new Set<HTMLIFrameElement>();
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node instanceof HTMLIFrameElement) frames.add(node);
            for (const frame of node.querySelectorAll("iframe"))
              frames.add(frame);
          }
      });
      observer.observe(center, { childList: true, subtree: true });
      return { frames, observer };
    });
    try {
      const entryResponse = page.waitForResponse((response) =>
        /\/plugin-assets\/sandbox-surface-probe\/[a-f0-9]{32}\/index\.html$/.test(
          new URL(response.url()).pathname,
        ),
      );
      await allowSandbox(page);
      const response = await entryResponse;
      expect(response.status()).toBe(200);
      expect(response.headers()["content-security-policy"]).toBe(
        PLUGIN_ASSET_PAGE_CSP,
      );
      const main = page.getByRole("region", {
        name: "Bridge reader",
        exact: true,
      });
      const frame = await expectSandboxStory(
        main,
        "Public reading theme story.",
      );
      expect(new URL(frame.url()).origin).toBe(new URL(page.url()).origin);
      const current = await main.locator("iframe").elementHandle();
      expect(
        await lifetime.evaluate(({ frames }, current) => {
          const first = frames.values().next().value;
          return {
            count: frames.size,
            sameElement: first === current,
            connected: first?.isConnected,
            owner: current?.closest("section")?.getAttribute("aria-label"),
          };
        }, current),
      ).toEqual({
        count: 1,
        sameElement: true,
        connected: true,
        owner: "Bridge reader",
      });
      await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(
        1,
      );
      await expect(main.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
    } finally {
      await lifetime.evaluate(({ observer }) => observer.disconnect());
      await lifetime.dispose();
    }
  } finally {
    await close(page, host);
  }
});

for (const width of [360, 1440])
  test(`host recovery and settings stay reachable at ${width}px and in immersive stage`, async ({
    page,
  }) => {
    const host = await startStageRenderHost({
      narration: "Public reading theme story.",
      plugins: ["dm-console"],
    });
    try {
      expect((await upload(host)).status).toBe(201);
      await host.restart();
      await enable(host);
      await connect(page, host);
      await page.setViewportSize({ width, height: 900 });
      await visit(page, host.sessionId);
      await composerInput(page).fill("Tell the story");
      await composerInput(page).press("Enter");
      await expect(page.getByTestId("story-segments")).toContainText(
        "Public reading theme story.",
      );
      await waitForTurnIdle(page);
      await select(page);
      await expect(
        page.locator('[data-covel-theme-part="story"]').first(),
      ).toHaveCSS("color", "rgb(245, 234, 210)");
      const settings = page
        .getByTestId("center-panel")
        .locator(".ui-session-header")
        .getByRole("button", { name: "设置", exact: true });
      await hit(settings);
      await settings.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.closest("[data-covel-theme-part]")),
      ).toBeNull();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "插件视图", exact: true }).click();
      const consoleView = page
        .getByRole("group", { name: "插件视图", exact: true })
        .getByRole("button", { name: /^主持人控制台/ });
      await hit(consoleView);
      await consoleView.click();
      await expect(page.getByTestId("plugin-view-bar")).toContainText(
        "主持人控制台",
      );
      await hit(
        page
          .getByTestId("session-recovery-controls")
          .getByRole("button", { name: "使用默认外观", exact: true }),
      );
      expect(
        await page
          .getByTestId("plugin-view-bar")
          .evaluate((element) => element.closest("[data-covel-theme-part]")),
      ).toBeNull();
      await page
        .getByTestId("plugin-view-bar")
        .getByRole("button", { name: "返回默认视图", exact: true })
        .click();
      await page.getByRole("button", { name: "舞台视图", exact: true }).click();
      await expect(
        page
          .getByTestId("stage-dialog")
          .locator('[data-covel-theme-part="dialogue"]'),
      ).toHaveCSS("color", "rgb(245, 234, 210)");
      await page.getByRole("button", { name: "全屏舞台", exact: true }).click();
      const reset = page.getByRole("button", {
        name: "使用默认外观",
        exact: true,
      });
      await hit(reset);
      await reset.click();
      await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(
        0,
      );
    } finally {
      await close(page, host);
    }
  });

for (const width of [360, 1440])
  test(`active themes preserve sandbox consent, revocation and immersive recovery at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const host = await startStageRenderHost({
      narration: "Public reading theme story.",
      fixturePlugins: [sandboxThemeFixture],
    });
    try {
      expect((await upload(host)).status).toBe(201);
      await host.restart();
      await enable(host);
      await observeSandboxPort(page);
      await connect(page, host);
      await page.setViewportSize({ width, height: 900 });
      await visit(page, host.sessionId);
      await composerInput(page).fill("Tell the public story");
      await composerInput(page).press("Enter");
      await waitForTurnIdle(page);
      await select(page);
      const story = page
        .locator('[data-covel-theme-part="story"]')
        .filter({ hasText: "Public reading theme story." });
      await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");

      await chooseSandboxReader(page);
      const consent = page.getByRole("dialog");
      await expect(consent).toContainText("读取公开故事与输入信息");
      await expect(
        page.getByTestId("plugin-view-container").locator("iframe"),
      ).toHaveCount(0);
      const decline = consent.getByRole("button", {
        name: "使用默认视图",
        exact: true,
      });
      await hit(decline);
      await decline.click();
      await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
      await chooseSandboxReader(page);
      await allowSandbox(page);
      const main = page.getByRole("region", {
        name: "Bridge reader",
        exact: true,
      });
      const frame = await expectSandboxStory(
        main,
        "Public reading theme story.",
      );
      await expect
        .poll(async () =>
          (await portMessages(frame)).some(
            (message) =>
              message.value?.theme?.id.startsWith(
                `plugin:${pluginId}:reading:`,
              ) && message.value.theme.tokens.background === "#24201a",
          ),
        )
        .toBe(true);
      await expect(main.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      await main
        .frameLocator("iframe")
        .getByRole("button", { name: "Fill viewport", exact: true })
        .click();
      const controls = page.getByTestId("sandbox-surface-controls");
      const back = controls.getByRole("button", {
        name: "切回默认界面",
        exact: true,
      });
      await hit(back);
      const permissions = main.getByRole("button", {
        name: "视图权限",
        exact: true,
      });
      await hit(permissions);
      await permissions.click();
      const revoke = main.getByRole("button", {
        name: "撤销此页面的全部权限",
        exact: true,
      });
      await hit(revoke);
      await revoke.click();
      await expect(main).toHaveCount(0);
      await expect(story).toHaveCSS("color", "rgb(245, 234, 210)");
      await chooseSandboxReader(page);
      await allowSandbox(page);
      await expectSandboxStory(main, "Public reading theme story.");
      await hit(back);
      await back.focus();
      await page.keyboard.press("Enter");
      await expect(main).toHaveCount(0);

      await controls
        .getByRole("combobox", { name: "输入框", exact: true })
        .selectOption("plugin:sandbox-surface-probe:input");
      await allowSandbox(page);
      const input = page.getByRole("region", {
        name: "Bridge input",
        exact: true,
      });
      await expectSandboxStory(input, "Public reading theme story.");
      await input
        .frameLocator("iframe")
        .getByRole("button", { name: "Fill viewport", exact: true })
        .click();
      await page.getByRole("button", { name: "舞台视图", exact: true }).click();
      // Entering stage moves the composer into StageView and mounts a new page.
      await expectSandboxStory(input, "Public reading theme story.");
      await input
        .frameLocator("iframe")
        .getByRole("button", { name: "Fill viewport", exact: true })
        .click();
      await expect(
        page
          .getByTestId("stage-dialog")
          .locator('[data-covel-theme-part="dialogue"]'),
      ).toHaveCSS("color", "rgb(245, 234, 210)");
      await page.getByTestId("stage-immersive-toggle").click();
      await expectSandboxStory(input, "Public reading theme story.");
      await hit(back);
      const reset = page.getByRole("button", {
        name: "使用默认外观",
        exact: true,
      });
      await hit(reset);
      await reset.click();
      await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(
        0,
      );
      await expect(input).toBeVisible();
      await hit(back);
      await back.click();
      await expect(input).toHaveCount(0);
    } finally {
      await close(page, host);
    }
  });

test("malicious uploaded styles are diagnosed atomically while an accepted pack keeps working", async ({
  page,
}) => {
  const host = await startStageRenderHost({
    narration: "Public reading theme story.",
    plugins: ["dm-console"],
  });
  const temp = await mkdtemp(join(tmpdir(), "theme-rejected-"));
  let releaseProbe: (() => void) | undefined;
  try {
    expect((await upload(host)).status).toBe(201);
    await host.restart();
    await enable(host);
    await connect(page, host);
    await visit(page, host.sessionId);
    await select(page);
    let release!: () => void;
    let readEntered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      releaseProbe = resolve;
    });
    const routePattern = "**/api/ui-specs?**";
    const deferredRead = async (route: import("@playwright/test").Route) => {
      readEntered = true;
      await gate;
      const url = new URL(route.request().url());
      await route.continue({
        url: `${host.baseUrl}${url.pathname}${url.search}`,
      });
    };
    await page.route(routePattern, deferredRead);
    await page.getByRole("button", { name: "会话主题", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "会话主题", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("group", { name: "会话主题", exact: true })
      .getByRole("button", { name: "重试", exact: true })
      .click();
    await expect
      .poll(() => readEntered, {
        message: "Theme retry must enter the held discovery route",
      })
      .toBe(true);
    await page
      .getByTestId("session-recovery-controls")
      .getByRole("button", { name: "使用默认外观", exact: true })
      .click();
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/ui-specs" && response.ok(),
    );
    release();
    await refreshed;
    await page.getByRole("button", { name: "会话主题", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "会话主题", exact: true }),
    ).toBeEnabled();
    await page.unroute(routePattern, deferredRead);
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    await page.reload();
    await select(page);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "image") requests.push(request.url());
    });
    const root = join(temp, "invalid-reading");
    await cp(fixture, root, { recursive: true });
    const cases = [
      "html{color:var(--story-color)}",
      ".story button{color:var(--story-color)}",
      "[data-test]{color:var(--story-color)}",
      ".story:has(button){color:var(--story-color)}",
      '@import "https://example.invalid/theme.css";',
      ...[
        "position:fixed",
        "position:absolute",
        "position:sticky",
        "width:99999px",
        "margin:-999px",
        "z-index:999999",
        "opacity:0",
        "pointer-events:none",
        'content:"Password"',
        "--other:red",
      ].map((declaration) => `.story{${declaration}}`),
      ...[
        "var(--image)",
        "image-set(url(paper.png) 1x)",
        "url(https://example.invalid/x.png)",
        "url(//example.invalid/x.png)",
        "url(data:image/png;base64,AA==)",
        "url(blob:fake)",
        "url(icon.svg)",
        "url(font.woff2)",
        "url(/api/config/keys)",
        "url(/plugin-assets/other/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/paper.png)",
        "url(/plugin-assets/theme-pack-probe/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/paper.png)",
        "url(%2e%2e/paper.png)",
      ].map((value) => `.surface{background-image:${value}}`),
    ];
    for (const css of cases) {
      await writeFile(
        join(root, "ui/reading-theme.css"),
        `.story{color:var(--story-color)}\n${css}`,
      );
      const response = await upload(host, root);
      expect(response.status, css).toBe(400);
      expect(await response.text()).toMatch(/theme|CSS|css|allowed|selector/);
      await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(
        1,
      );
    }
    expect(
      requests.some(
        (url) => url.includes("example.invalid") || url.includes("/api/config"),
      ),
    ).toBe(false);
  } finally {
    releaseProbe?.();
    await close(page, host);
    await rm(temp, { recursive: true, force: true });
  }
});

test("appearance changes make no action requests during a running turn and discovery excludes private data", async ({
  page,
}) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const host = await startStageRenderHost({
    narration: "Public reading theme story.",
    beforeGenerate: async () => {
      calls++;
      started();
      await gate;
    },
  });
  try {
    expect((await upload(host)).status).toBe(201);
    await host.restart();
    await enable(host);
    const timestamp = new Date().toISOString();
    await host.store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: host.sessionId,
      pluginId,
      namespace: "_hidden.private",
      key: "secret",
      value: { text: "private-theme-sentinel" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await connect(page, host);
    await visit(page, host.sessionId);
    await select(page);
    const theme = await themeIdentity(host);
    expect(JSON.stringify(theme)).not.toContain("private-theme-sentinel");
    await composerInput(page).fill("Tell the public story");
    await composerInput(page).press("Enter");
    await running;
    await expect(page.getByTestId("game-composer")).toHaveAttribute(
      "data-executing",
      "true",
    );
    const stop = page
      .getByTestId("game-composer")
      .getByRole("button", { name: /停止/ });
    await hit(stop);
    const before = await controlStyle(stop);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
        writes.push(new URL(request.url()).pathname);
    });
    await page
      .getByTestId("session-recovery-controls")
      .getByRole("button", { name: "使用默认外观", exact: true })
      .click();
    await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(0);
    await select(page);
    await hit(stop);
    expect(await controlStyle(stop)).toEqual(before);
    expect(calls).toBe(1);
    expect(writes).toEqual([]);
    expect(
      await page.evaluate(() =>
        Object.keys(
          JSON.parse(localStorage.getItem("covel:settings") ?? "{}").entries ??
            {},
        ).filter((key) => key.startsWith("ui.pluginViewConsent.")),
      ),
    ).toEqual([]);
    release();
    await waitForTurnIdle(page);
    await expect(
      page.getByText("Public reading theme story.", { exact: true }),
    ).toBeVisible();
    expect(
      (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
    ).toBe(1);
    const response = await api(
      host,
      `/api/ui-specs?sessionId=${host.sessionId}`,
    ).then((result) => result.text());
    expect(response).not.toContain("private-theme-sentinel");
    await expect(page.locator("body")).not.toContainText(
      "private-theme-sentinel",
    );
  } finally {
    release();
    await close(page, host);
  }
});

test("theme toggles preserve streamed public stories and an explicit failed-operation retry without leaking private port data", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await startThemeOrchestrationHost();
  const { host } = fixture;
  try {
    expect((await upload(host)).status).toBe(201);
    await host.restart();
    await enable(host);
    const timestamp = new Date().toISOString();
    await host.store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: host.sessionId,
      pluginId: "theme-story-probe",
      namespace: "_hidden.private",
      key: "secret",
      value: { text: themeSecrets[0] },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await observeSandboxPort(page);
    await connect(page, host);
    await visit(page, host.sessionId);
    await select(page);
    const controls = page.getByTestId("sandbox-surface-controls");
    await controls
      .getByRole("combobox", { name: "输入框", exact: true })
      .selectOption("plugin:sandbox-surface-probe:input");
    await allowSandbox(page);
    const input = page.getByRole("region", {
      name: "Bridge input",
      exact: true,
    });
    await expect(input.locator("[data-page-status]")).toHaveAttribute(
      "data-page-status",
      "ready",
    );
    const frame = page
      .frames()
      .find((frame) =>
        frame.url().includes("/plugin-assets/sandbox-surface-probe/"),
      );
    expect(frame).toBeDefined();
    const sandbox = input.frameLocator("iframe");
    const actions: unknown[] = [];
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
        writes.push(new URL(request.url()).pathname);
      if (new URL(request.url()).pathname === "/api/actions")
        actions.push(request.postDataJSON());
    });
    const reset = page
      .getByTestId("session-recovery-controls")
      .getByRole("button", { name: "使用默认外观", exact: true });
    for (let turn = 0; turn < 2; turn++) {
      if (turn === 1) fixture.allowChange();
      await sandbox
        .getByLabel("Player action")
        .fill(
          turn === 0
            ? "Tell the public story and record the change"
            : "Try the refused change again",
        );
      await sandbox
        .getByRole("button", { name: "Submit action", exact: true })
        .click();
      await expect(sandbox.locator("#story")).toContainText(
        "Public streaming ",
      );
      await expect
        .poll(() =>
          frame!.evaluate(() => {
            const bridge = window as unknown as {
              covel: { getState(): { session: unknown } };
            };
            return bridge.covel.getState().session;
          }),
        )
        .toMatchObject({
          executing: true,
          turn,
          streaming: { text: "Public streaming " },
        });
      // A real second delta follows the full-state baseline on the same port.
      const envelopes = (await portMessages(frame!)).length;
      fixture.nextDelta(turn);
      await expect
        .poll(async () =>
          (await portMessages(frame!))
            .slice(envelopes)
            .some(
              (message) =>
                message.type === "stream" &&
                message.append?.includes("theme story."),
            ),
        )
        .toBe(true);
      await expect(sandbox.locator("#story")).toContainText(
        streamingThemeStory,
      );
      const stop = controls.getByRole("button", { name: "停止", exact: true });
      await hit(stop);
      const before = await controlStyle(stop);
      const writesBefore = [...writes];
      await hit(reset);
      await reset.click();
      await expect(page.locator("style[data-plugin-theme-style]")).toHaveCount(
        0,
      );
      await expect
        .poll(async () => {
          const theme = (await portMessages(frame!))
            .filter((message) => message.type === "state")
            .at(-1)?.value?.theme;
          return theme !== undefined && !theme.id.startsWith("plugin:");
        })
        .toBe(true);
      await select(page);
      await expect
        .poll(
          async () =>
            (await portMessages(frame!))
              .filter((message) => message.type === "state")
              .at(-1)?.value?.theme?.tokens.background,
        )
        .toBe("#24201a");
      await hit(stop);
      expect(await controlStyle(stop)).toEqual(before);
      expect(writes).toEqual(writesBefore);
      expect(actions).toHaveLength(turn + 1);
      await assertPrivateThemeDataAbsent(page, host, frame!);
      fixture.release(turn);
      await expect
        .poll(async () =>
          (await portMessages(frame!)).some(
            (message) =>
              message.value?.session?.executing === false &&
              message.value.session.turn === turn + 1,
          ),
        )
        .toBe(true);
      const story = page
        .locator('[data-covel-theme-part="story"]')
        .filter({ hasText: streamingThemeStory });
      await expect(story.last()).toHaveCSS("color", "rgb(245, 234, 210)");
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(turn + 1);
      const values = await host.store.queryPluginData({
        sessionId: host.sessionId,
        pluginId: "theme-story-probe",
        namespace: "values",
      });
      if (turn === 0) {
        expect(values).toEqual([]);
        const notice = page.getByText("本回合有 1 个操作没有生效。", {
          exact: true,
        });
        await expect(notice).toBeVisible();
        expect(
          await notice.evaluate((element) =>
            element.closest("[data-covel-theme-part]"),
          ),
        ).toBeNull();
        await reset.click();
        await select(page);
        expect(actions).toHaveLength(1);
      } else
        expect(values).toContainEqual(
          expect.objectContaining({ key: "change", value: true }),
        );
      await expect(page.getByTestId("execution-recovery-notice")).toHaveCount(
        0,
      );
      await expect(
        controls.getByRole("button", { name: "停止", exact: true }),
      ).toHaveCount(0);
      await assertPrivateThemeDataAbsent(page, host, frame!);
    }
    expect(fixture.calls).toEqual([
      "concealed",
      "delegate",
      "actor",
      "change",
      "story",
      "concealed",
      "delegate",
      "actor",
      "change",
      "story",
    ]);
    expect(actions).toEqual([
      expect.objectContaining({
        type: "submit_actions",
        payload: expect.objectContaining({
          actions: [
            expect.objectContaining({
              text: "Tell the public story and record the change",
            }),
          ],
        }),
      }),
      expect.objectContaining({
        type: "submit_actions",
        payload: expect.objectContaining({
          actions: [
            expect.objectContaining({ text: "Try the refused change again" }),
          ],
        }),
      }),
    ]);
    expect(
      (
        await host.store.queryTraceEvents(host.sessionId, {
          types: ["operation.failed"],
        })
      ).length,
    ).toBe(1);
  } finally {
    fixture.nextDelta(0);
    fixture.nextDelta(1);
    fixture.release(0);
    fixture.release(1);
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "wait" });
    await fixture.close();
  }
});
