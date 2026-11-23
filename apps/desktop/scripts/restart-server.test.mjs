import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { bundleDesktopEntry } from "./bundle-desktop.mjs";

test("preload works without Electron 45's removed Node shims and hides IPC events", async () => {
  const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
  const bundle = await bundleDesktopEntry(desktopRoot, "preload", {
    write: false,
    sourcemap: false,
  });
  const ipcRenderer = new EventEmitter();
  const invocations = [];
  ipcRenderer.invoke = async (...args) => {
    invocations.push(args);
    return { ok: true };
  };
  let api;
  const pageListeners = new Map();
  const sandbox = {
    module: { exports: {} },
    process: { platform: "darwin", env: {} },
    console: { warn() {} },
    window: {
      addEventListener: (event, listener) => pageListeners.set(event, listener),
    },
    require(name) {
      assert.equal(
        name,
        "electron",
        "sandbox preload may only require Electron",
      );
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "covelIpc");
            api = value;
          },
        },
      };
    },
  };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  assert.equal(api.isDesktop, true);
  assert.equal(api.platform, "darwin");
  assert.match(api.appVersion, /^\d+\.\d+\.\d+/);
  assert.equal(api.send, undefined);
  await assert.rejects(api.invoke("untrusted:channel"), /blocked invoke/);
  assert.deepEqual(invocations, []);
  assert.deepEqual(await api.invoke("covel:retry-startup"), { ok: true });
  assert.deepEqual(invocations, [["covel:retry-startup", undefined]]);

  const received = [];
  const unsubscribe = api.on("covel:startup:error", (...args) =>
    received.push(args),
  );
  const payload = { title: "Startup failed" };
  ipcRenderer.emit(
    "covel:startup:error",
    { sender: "must stay private" },
    payload,
  );
  assert.deepEqual(received, [[payload]]);
  unsubscribe();
  assert.equal(ipcRenderer.listenerCount("covel:startup:error"), 0);
  api.on("untrusted:channel", () => assert.fail("blocked subscription ran"));
  assert.equal(ipcRenderer.listenerCount("untrusted:channel"), 0);
  api.on("covel:startup:error", () => {});
  api.on("covel:server:status", () => {});
  pageListeners.get("beforeunload")();
  assert.deepEqual(ipcRenderer.eventNames(), []);
});

test("restart IPC navigates the native window only after the sidecar is ready", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-restart-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture.mjs");
  await writeFile(
    fixture,
    `
    export const handlers = new Map();
    export const navigation = [];
    export const openedPaths = [];
    export const window = {
      destroyed: false,
      url: "http://127.0.0.1:9479/session",
      isDestroyed() { return this.destroyed; },
      webContents: {
        reload() { navigation.push("reload"); },
        getURL() { return window.url; },
      },
    };
    export const titleBarColors = [];
    export const app = { getVersion: () => "0.0.54" };
    export const BrowserWindow = { fromWebContents: () => window };
    export const setTitleBarColors = (win, colors) => { titleBarColors.push(colors); };
    export const dialog = {};
    export const Menu = {};
    export const shell = { openPath: async (target) => { openedPaths.push(target); } };
    export const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on() {} };
    export const getMainWindow = () => window;
    export const getMainWindowUrl = () => (window.destroyed ? undefined : window.url);
    export const navigateToApp = (win, port) => { navigation.push(port); };
    export const openExternalUrl = (url) => { openedPaths.push(url); };
    export const buildAppMenu = () => {};
    export const writeLog = () => {};
    export const patchKeysEnv = () => {};
    export const loadKeysEnv = () => ({ OPENAI_API_KEY: "secret-key" });
    export const writeDataRoot = () => {};
    export const configuredDataRoot = () => "";
    export const dataRootCopyRecordPath = () => "";
    export const setDesktopLocaleFromSettings = () => {};
    export const t = (value) => value;
    export const isSettingsEntries = () => true;
    export const readSettingsBundle = () => {};
    export const writeSettingsEntriesAtomic = () => {};
    export const backupSettingsFile = () => {};
    export const listSettingsBackups = () => [];
    export const readSettingsBackup = () => null;
  `,
    "utf8",
  );
  const output = path.join(root, "ipc.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/ipc-handlers.ts", import.meta.url)),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "desktop-services",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(electron|\.\/(env-files|paths|windows|logging|main-i18n|settings-json)\.js)$/,
            },
            // An external path is imported as written: Windows needs a file URL.
            () => ({ path: pathToFileURL(fixture).href, external: true }),
          );
        },
      },
    ],
  });
  const { registerDesktopIpcHandlers } = await import(
    pathToFileURL(output).href
  );
  const { handlers, navigation, openedPaths, titleBarColors, window } =
    await import(pathToFileURL(fixture).href);
  const frame = {
    url: "http://127.0.0.1:9479/session",
    origin: "http://127.0.0.1:9479",
  };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  let retryCalls = 0;
  const setup = (restartServer, isDev = false) => {
    navigation.length = 0;
    openedPaths.length = 0;
    retryCalls = 0;
    window.destroyed = false;
    window.url = "http://127.0.0.1:9479/session";
    registerDesktopIpcHandlers({
      paths: {
        covelHome: "/tmp/covel",
        dataRoot: "/tmp/covel/data",
        logsDir: "/tmp/covel/logs",
        userKeysEnvPath: "/tmp/covel/keys.env",
      },
      restToken: "rest-secret",
      retryStartup: () => {
        retryCalls++;
      },
      restartServer,
      isDev,
      getServerPort: () => 9479,
    });
    return handlers.get("covel:restart-server");
  };

  await t.test(
    "new sidecar port is navigated by the main process",
    async () => {
      const ready = Promise.withResolvers();
      const restart = setup(() => ready.promise);
      const pending = restart(event);
      assert.deepEqual(navigation, []);
      ready.resolve({ ok: true, port: 5258 });
      assert.deepEqual(await pending, { ok: true, port: 5258 });
      assert.deepEqual(navigation, [5258]);
    },
  );

  await t.test("failed restarts do not navigate", async () => {
    const result = { ok: false, port: 5258, error: "Synthetic start failure" };
    assert.deepEqual(await setup(async () => result)(event), result);
    assert.deepEqual(navigation, []);
  });

  await t.test(
    "concurrent requests share one restart and one navigation",
    async () => {
      const ready = Promise.withResolvers();
      let starts = 0;
      const restart = setup(() => {
        starts++;
        return ready.promise;
      });
      const first = restart(event);
      const second = restart(event);
      ready.resolve({ ok: true, port: 5258 });
      await Promise.all([first, second]);
      assert.equal(starts, 1);
      assert.deepEqual(navigation, [5258]);
    },
  );

  await t.test(
    "failed requests release the restart gate for retry",
    async () => {
      let attempts = 0;
      const restart = setup(async () => {
        if (++attempts === 1) throw new Error("Synthetic restart failure");
        return { ok: true, port: 5258 };
      });
      await assert.rejects(restart(event), /Synthetic restart failure/);
      await restart(event);
      assert.deepEqual(navigation, [5258]);
    },
  );

  await t.test(
    "development refuses restart without touching the external server",
    async () => {
      let calls = 0;
      const restart = setup(async () => {
        calls++;
        return { ok: true, port: 5258 };
      }, true);
      for (const result of await Promise.all([
        restart(event),
        restart(event),
      ])) {
        assert.deepEqual(result, {
          ok: false,
          port: 9479,
          error: "server.externallyManagedRestart",
        });
      }
      assert.equal(calls, 0);
      assert.deepEqual(navigation, []);
    },
  );

  await t.test(
    "closing the window while restarting does not navigate",
    async () => {
      const restart = setup(async () => {
        window.destroyed = true;
        return { ok: true, port: 5258 };
      });
      await restart(event);
      assert.deepEqual(navigation, []);
    },
  );

  await t.test("untrusted frames cannot restart the sidecar", async () => {
    let calls = 0;
    const restart = setup(async () => {
      calls++;
    });
    const externalFrame = {
      url: "https://untrusted.example",
      origin: "https://untrusted.example",
    };
    await restart({
      senderFrame: externalFrame,
      sender: { mainFrame: externalFrame },
    });
    assert.equal(calls, 0);
    assert.deepEqual(navigation, []);
  });

  await t.test(
    "sensitive and recovery IPC reject child, opaque-origin, and plugin-hosted frames",
    async () => {
      setup(async () => {
        throw new Error("must not restart");
      });
      const pluginAssetUrl =
        "http://127.0.0.1:9479/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html";
      const pluginFrameUrl = "http://127.0.0.1:9479/plugin-frame.html";
      const untrustedEvents = [
        // Same-origin child frame (not mainFrame)
        { senderFrame: { ...frame }, sender: event.sender },
        // Missing frame
        { senderFrame: null, sender: event.sender },
        // Sandboxed opaque origin on loopback app URL (main frame)
        (() => {
          const f = { url: frame.url, origin: "null" };
          return { senderFrame: f, sender: { mainFrame: f } };
        })(),
        // Missing origin on loopback app URL
        (() => {
          const f = { url: frame.url, origin: undefined };
          return { senderFrame: f, sender: { mainFrame: f } };
        })(),
        // Sandboxed /plugin-assets/... with opaque origin
        (() => {
          const f = { url: pluginAssetUrl, origin: "null" };
          return { senderFrame: f, sender: { mainFrame: f } };
        })(),
        // /plugin-assets/... even with matching loopback origin
        (() => {
          const f = { url: pluginAssetUrl, origin: frame.origin };
          return { senderFrame: f, sender: { mainFrame: f } };
        })(),
        // /plugin-frame.html even with matching loopback origin
        (() => {
          const f = { url: pluginFrameUrl, origin: frame.origin };
          return { senderFrame: f, sender: { mainFrame: f } };
        })(),
      ];
      for (const untrusted of untrustedEvents) {
        assert.deepEqual(await handlers.get("covel:keys:load")(untrusted), {});
        assert.deepEqual(
          await handlers.get("covel:keys:save")(untrusted, { key: "secret" }),
          { ok: false },
        );
        assert.equal(await handlers.get("covel:get-info")(untrusted), null);
        assert.equal(
          await handlers.get("covel:settings:load")(untrusted),
          null,
        );
        assert.deepEqual(
          await handlers.get("covel:settings:save")(untrusted, {
            entries: {},
            expectedRevision: 0,
          }),
          { ok: false },
        );
        await handlers.get("covel:restart-server")(untrusted);
        await handlers.get("covel:retry-startup")(untrusted);
        await handlers.get("covel:open-logs-dir")(untrusted);
        await handlers.get("covel:open-data-dir")(untrusted);
      }
      assert.equal(retryCalls, 0);
      assert.deepEqual(openedPaths, []);
    },
  );

  await t.test(
    "committed splash document may use recovery channels only, never secret channels",
    async () => {
      setup(async () => {
        throw new Error("must not restart");
      });
      const splashUrl =
        "data:text/html;charset=utf-8,%3Ch1%3ESplash%3C%2Fh1%3E";
      window.url = splashUrl;
      const splashFrame = { url: splashUrl, origin: "null" };
      const splashEvent = {
        senderFrame: splashFrame,
        sender: { mainFrame: splashFrame },
      };
      assert.equal(await handlers.get("covel:get-info")(splashEvent), null);
      assert.deepEqual(await handlers.get("covel:keys:load")(splashEvent), {});
      await handlers.get("covel:open-config-dir")(splashEvent);
      assert.deepEqual(openedPaths, []);

      await handlers.get("covel:retry-startup")(splashEvent);
      await handlers.get("covel:open-logs-dir")(splashEvent);
      await handlers.get("covel:open-data-dir")(splashEvent);
      assert.equal(retryCalls, 1);
      assert.deepEqual(openedPaths, ["/tmp/covel/logs", "/tmp/covel/data"]);
    },
  );

  await t.test(
    "window button colours come only from the app, as hex",
    async () => {
      setup(async () => ({ ok: true, port: 5258 }));
      const setColors = handlers.get("covel:title-bar:set-colors");
      const colors = { background: "#f2ece3", foreground: "#1c140e" };
      const untrustedFrame = {
        url: "https://untrusted.example",
        origin: "https://untrusted.example",
      };
      await setColors(
        {
          senderFrame: untrustedFrame,
          sender: { mainFrame: untrustedFrame },
        },
        colors,
      );
      await setColors(event, { background: "red", foreground: "#1c140e" });
      await setColors(event, { background: "#f2ece3" });
      await setColors(event, null);
      assert.deepEqual(titleBarColors, []);
      await setColors(event, colors);
      assert.deepEqual(titleBarColors, [colors]);
    },
  );
});

test("automatic sidecar recovery owns readiness, navigation, and a finite restart budget", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "recovery.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/server-recovery.ts", import.meta.url)),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { createHealthHeartbeat, createServerRecovery, findStartablePort } =
    await import(pathToFileURL(output).href);
  const waitUntil = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("recovery state did not arrive");
  };

  const navigation = [];
  const states = [];
  let starts = 0;
  let recovery;
  recovery = createServerRecovery({
    restart: async () => {
      const number = ++starts;
      recovery.ready(`child-${number}`);
      return 5000 + number;
    },
    navigate: (port) => navigation.push(port),
    status: (state, attempts) => states.push({ state, attempts }),
    log: () => {},
    retryBaseMs: 1,
    stableMs: 30,
  });
  t.after(() => recovery.cancel());

  // A boot process can live well beyond two seconds yet never become ready.
  recovery.exited("unready-child");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(starts, 0);

  recovery.ready("initial-child");
  recovery.exited("initial-child");
  await waitUntil(() => starts === 1 && navigation.length === 1);
  assert.deepEqual(navigation, [5001]);

  recovery.exited("child-1");
  await waitUntil(() => starts === 2 && navigation.length === 2);
  recovery.exited("child-2");
  await waitUntil(() => starts === 3 && navigation.length === 3);
  recovery.exited("child-3");
  await waitUntil(() => states.at(-1)?.state === "down");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(starts, 3);
  assert.deepEqual(navigation, [5001, 5002, 5003]);
  assert.deepEqual(states.at(-1), { state: "down", attempts: 3 });

  // A stable runtime earns a fresh budget after the prior budget was spent.
  recovery.ready("stable-child");
  await new Promise((resolve) => setTimeout(resolve, 40));
  recovery.exited("stable-child");
  await waitUntil(() => starts === 4 && navigation.length === 4);
  assert.deepEqual(states.at(-1), { state: "up", attempts: 1 });

  await recovery.cancel();
  recovery.resetBudget();
  recovery.ready("manual-child");
  recovery.exited("manual-child");
  await waitUntil(() => starts === 5 && navigation.length === 5);

  const failedNavigation = [];
  const failedStates = [];
  let failedStarts = 0;
  const failedRecovery = createServerRecovery({
    restart: async () => {
      failedStarts++;
      throw new Error("Synthetic readiness failure");
    },
    navigate: (port) => failedNavigation.push(port),
    status: (state) => failedStates.push(state),
    log: () => {},
    maxAttempts: 1,
    retryBaseMs: 1,
  });
  t.after(() => failedRecovery.cancel());
  failedRecovery.ready("failed-child");
  failedRecovery.exited("failed-child");
  await waitUntil(() => failedStates.at(-1) === "down");
  assert.equal(failedStarts, 1);
  assert.deepEqual(failedNavigation, []);

  const pendingPort = Promise.withResolvers();
  const cancelledNavigation = [];
  let pendingStarts = 0;
  const cancelledRecovery = createServerRecovery({
    restart: async () => {
      pendingStarts++;
      return pendingPort.promise;
    },
    navigate: (port) => cancelledNavigation.push(port),
    status: () => {},
    log: () => {},
    retryBaseMs: 1,
  });
  cancelledRecovery.ready("old-child");
  cancelledRecovery.exited("old-child");
  await waitUntil(() => pendingStarts === 1);
  const stopped = cancelledRecovery.cancel();
  pendingPort.resolve(5010);
  await stopped;
  assert.deepEqual(cancelledNavigation, []);

  const discoveredPort = Promise.withResolvers();
  let manuallyStopped = false;
  const starting = findStartablePort(
    () => discoveredPort.promise,
    () => manuallyStopped,
  );
  manuallyStopped = true;
  discoveredPort.resolve(5011);
  await assert.rejects(starting, /shutting down/);

  await t.test(
    "health heartbeat skips destroyed windows and resets lastHealthOk on restart",
    async (sub) => {
      sub.mock.timers.enable({ apis: ["setInterval"] });
      const liveMessages = [];
      let nextCheck = async () => ({ ok: true });
      const destroyedWindow = {
        isDestroyed: () => true,
        webContents: {
          send: () => {
            throw new Error("Object has been destroyed");
          },
        },
      };
      const liveWindow = {
        isDestroyed: () => false,
        webContents: {
          send: (channel, payload) => liveMessages.push([channel, payload]),
        },
      };
      const heartbeat = createHealthHeartbeat({
        checkHealth: (url) => nextCheck(url),
        getWindows: () => [destroyedWindow, liveWindow],
        intervalMs: 100,
      });
      sub.after(() => heartbeat.stop());

      // First server goes down -> emits "down" to live window only.
      heartbeat.start("http://127.0.0.1:3001/api/health");
      nextCheck = async () => {
        throw new Error("ECONNREFUSED");
      };
      sub.mock.timers.tick(100);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(liveMessages, [
        ["covel:server:status", { state: "down" }],
      ]);

      // Fresh/restarted server starts -> lastHealthOk resets to true so an
      // immediate crash before the first passing poll still emits "down".
      liveMessages.length = 0;
      heartbeat.start("http://127.0.0.1:3002/api/health");
      sub.mock.timers.tick(100);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(liveMessages, [
        ["covel:server:status", { state: "down" }],
      ]);

      // Degraded -> up transitions skip destroyed windows too.
      liveMessages.length = 0;
      heartbeat.start("http://127.0.0.1:3003/api/health");
      nextCheck = async () => ({ ok: false });
      sub.mock.timers.tick(100);
      await Promise.resolve();
      await Promise.resolve();
      nextCheck = async () => ({ ok: true });
      sub.mock.timers.tick(100);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(liveMessages, [
        ["covel:server:status", { state: "degraded" }],
        ["covel:server:status", { state: "up" }],
      ]);

      // Stale in-flight check from a stopped server must not emit after restart.
      liveMessages.length = 0;
      const stale = Promise.withResolvers();
      nextCheck = () => stale.promise;
      heartbeat.start("http://127.0.0.1:3004/api/health");
      sub.mock.timers.tick(100);
      heartbeat.start("http://127.0.0.1:3005/api/health");
      stale.reject(new Error("old server exited"));
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(liveMessages, []);
    },
  );
});

test("startup errors wait for the splash load and are sent once", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-splash-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "windows.mjs");
  const mockFixture = path.join(root, "electron-mock.mjs");
  await writeFile(
    mockFixture,
    `
    import { EventEmitter } from "node:events";
    export const openExternalCalls = [];
    export const createdWindows = [];
    export const app = { name: "Covel" };
    export class BrowserWindow extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
        this.url = "http://127.0.0.1:3001/session";
        this.webContents = Object.assign(new EventEmitter(), {
          mainFrame: { origin: "http://127.0.0.1:3001" },
          getURL: () => this.url,
          setWindowOpenHandler: (handler) => { this.windowOpenHandler = handler; },
          send: () => {},
          executeJavaScript: async () => "",
        });
        createdWindows.push(this);
      }
      isDestroyed() { return this.destroyed; }
      setFullScreen() {}
      maximize() {}
      show() {}
      setTitle() {}
      setTitleBarOverlay() {}
      loadURL() { return Promise.resolve(); }
    }
    export const dialog = { showMessageBoxSync: () => 1 };
    export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
    export const shell = { openExternal: (url) => { openExternalCalls.push(url); } };
    export const nativeTheme = { shouldUseDarkColors: false };
    export const isDev = false;
    export const resolvePreloadScript = () => "";
    export const resolveWindowIconPath = () => "";
    export const attachWindowStateTracking = () => {};
    export const resolveInitialWindowOptions = () => ({
      width: 1200,
      height: 800,
      initial: { fullScreen: false, maximize: false },
    });
    export const buildSplashHtml = () => "<html>splash</html>";
    export const writeLog = () => {};
    export const t = (value) => value;
  `,
    "utf8",
  );
  await build({
    entryPoints: [fileURLToPath(new URL("../src/windows.ts", import.meta.url))],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "window-services",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(electron|\.\/(paths|window-state|splash-screen|logging|main-i18n)\.js)$/,
            },
            () => ({ path: pathToFileURL(mockFixture).href, external: true }),
          );
        },
      },
    ],
  });
  const {
    createMainWindow,
    installSessionPermissionHandlers,
    isTrustedFrameUrl,
    showStartupError,
  } = await import(pathToFileURL(output).href);
  const { openExternalCalls } = await import(pathToFileURL(mockFixture).href);

  await t.test("startup error delivery", async (sub) => {
    sub.mock.timers.enable({ apis: ["setTimeout"] });
    const messages = [];
    let destroyed = false;
    let loaded = Promise.withResolvers();
    const win = {
      loadURL: () => loaded.promise,
      isDestroyed: () => destroyed,
      setTitleBarOverlay() {},
      webContents: { send: (...args) => messages.push(args) },
    };
    const error = {
      title: "Failed",
      detail: "Synthetic failure",
      logs: "stderr",
    };
    const pending = showStartupError(win, error);
    sub.mock.timers.tick(500);
    await Promise.resolve();
    assert.deepEqual(messages, []);
    loaded.resolve();
    await pending;
    assert.deepEqual(messages, [["covel:startup:error", error]]);
    loaded = Promise.withResolvers();
    const closed = showStartupError(win, error);
    destroyed = true;
    loaded.resolve();
    await closed;
    assert.equal(messages.length, 1);
    destroyed = false;
    loaded = Promise.withResolvers();
    const failed = showStartupError(win, error);
    loaded.reject(new Error("load failed"));
    await assert.rejects(failed, /load failed/);
    assert.equal(messages.length, 1);
  });

  await t.test(
    "isTrustedFrameUrl and guardNavigation block top-level plugin document paths while allowing app routes and subframes",
    () => {
      openExternalCalls.length = 0;
      const win = createMainWindow();
      win.url = "http://127.0.0.1:3001/session";

      assert.equal(isTrustedFrameUrl("http://127.0.0.1:3001/"), true);
      assert.equal(
        isTrustedFrameUrl("http://127.0.0.1:3001/sessions/s-1"),
        true,
      );
      assert.equal(isTrustedFrameUrl("http://127.0.0.1:3001/settings"), true);
      assert.equal(
        isTrustedFrameUrl(
          "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
        ),
        false,
      );
      assert.equal(
        isTrustedFrameUrl("http://127.0.0.1:3001/plugin-frame.html"),
        false,
      );

      const emitNav = (eventName, targetUrl, isMainFrame = true) => {
        let prevented = false;
        win.webContents.emit(
          eventName,
          {
            isMainFrame,
            url: targetUrl,
            preventDefault() {
              prevented = true;
            },
          },
          targetUrl,
          false,
          isMainFrame,
        );
        return prevented;
      };

      // Top-level navigation / redirect to plugin assets or plugin frame is blocked
      // AND must not hand the blocked plugin page off to shell.openExternal.
      assert.equal(
        emitNav(
          "will-navigate",
          "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
          true,
        ),
        true,
      );
      assert.equal(
        emitNav(
          "will-redirect",
          "http://127.0.0.1:3001/plugin-frame.html",
          true,
        ),
        true,
      );
      assert.deepEqual(openExternalCalls, []);

      // Subframe navigation to plugin pages stays allowed (governed by iframe sandbox/CSP).
      assert.equal(
        emitNav(
          "will-navigate",
          "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
          false,
        ),
        false,
      );

      // Normal app routes stay allowed in main frame.
      assert.equal(
        emitNav("will-navigate", "http://127.0.0.1:3001/settings", true),
        false,
      );

      // window.open to plugin-hosted paths is also denied without opening externally.
      assert.deepEqual(
        win.windowOpenHandler({
          url: "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
        }),
        { action: "deny" },
      );
      assert.deepEqual(openExternalCalls, []);

      // External HTTPS navigation is blocked in-window and opened in system browser.
      assert.equal(
        emitNav("will-navigate", "https://example.com/docs", true),
        true,
      );
      assert.deepEqual(openExternalCalls, ["https://example.com/docs"]);
    },
  );

  await t.test(
    "session permission handlers fail closed except clipboard-sanitized-write for trusted main frame",
    () => {
      const win = createMainWindow();
      win.url = "http://127.0.0.1:3001/session";
      let checkHandler;
      let requestHandler;
      installSessionPermissionHandlers({
        setPermissionCheckHandler(fn) {
          checkHandler = fn;
        },
        setPermissionRequestHandler(fn) {
          requestHandler = fn;
        },
      });
      assert.equal(typeof checkHandler, "function");
      assert.equal(typeof requestHandler, "function");

      const request = (wc, permission, details) => {
        let granted;
        requestHandler(
          wc,
          permission,
          (value) => {
            granted = value;
          },
          details,
        );
        return granted;
      };

      const appDetails = {
        isMainFrame: true,
        requestingUrl: "http://127.0.0.1:3001/session",
      };
      assert.equal(
        checkHandler(
          win.webContents,
          "clipboard-sanitized-write",
          "http://127.0.0.1:3001/",
          appDetails,
        ),
        true,
      );
      assert.equal(
        request(win.webContents, "clipboard-sanitized-write", appDetails),
        true,
      );

      for (const perm of [
        "media",
        "geolocation",
        "notifications",
        "clipboard-read",
        "openExternal",
      ]) {
        assert.equal(
          checkHandler(
            win.webContents,
            perm,
            "http://127.0.0.1:3001/",
            appDetails,
          ),
          false,
          perm,
        );
        assert.equal(request(win.webContents, perm, appDetails), false, perm);
      }

      const pluginDetails = {
        isMainFrame: false,
        requestingUrl:
          "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
      };
      assert.equal(
        checkHandler(
          win.webContents,
          "clipboard-sanitized-write",
          "null",
          pluginDetails,
        ),
        false,
      );
      assert.equal(
        request(win.webContents, "clipboard-sanitized-write", pluginDetails),
        false,
      );

      // Even if mainFrame reports opaque origin, deny clipboard-sanitized-write.
      win.webContents.mainFrame = { origin: "null" };
      assert.equal(
        request(win.webContents, "clipboard-sanitized-write", appDetails),
        false,
      );
    },
  );
});
