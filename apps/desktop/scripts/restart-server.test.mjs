import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("restart IPC navigates the native window only after the sidecar is ready", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-restart-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture.mjs");
  await writeFile(
    fixture,
    `
    export const handlers = new Map();
    export const navigation = [];
    export const window = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      webContents: { reload() { navigation.push("reload"); } },
    };
    export const titleBarColors = [];
    export const app = {};
    export const BrowserWindow = { fromWebContents: () => window };
    export const setTitleBarColors = (win, colors) => { titleBarColors.push(colors); };
    export const dialog = {};
    export const Menu = {};
    export const shell = {};
    export const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on() {} };
    export const getMainWindow = () => window;
    export const navigateToApp = (win, port) => { navigation.push(port); };
    export const isTrustedFrameUrl = (url) => url === "http://127.0.0.1:9479/session";
    export const isTrustedStartupFrameUrl = () => false;
    export const buildAppMenu = () => {};
    export const writeLog = () => {};
    export const patchKeysEnv = () => {};
    export const loadKeysEnv = () => {};
    export const writeDataRoot = () => {};
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
            () => ({ path: fixture, external: true }),
          );
        },
      },
    ],
  });
  const { registerDesktopIpcHandlers } = await import(
    pathToFileURL(output).href
  );
  const { handlers, navigation, titleBarColors, window } = await import(
    pathToFileURL(fixture).href
  );
  const event = { senderFrame: { url: "http://127.0.0.1:9479/session" } };
  const setup = (restartServer, isDev = false) => {
    navigation.length = 0;
    window.destroyed = false;
    registerDesktopIpcHandlers({ paths: {}, restartServer, isDev });
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

  await t.test("development keeps the Vite frontend origin", async () => {
    await setup(async () => ({ ok: true, port: 5258 }), true)(event);
    assert.deepEqual(navigation, ["reload"]);
  });

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
    await restart({ senderFrame: { url: "https://untrusted.example" } });
    assert.equal(calls, 0);
    assert.deepEqual(navigation, []);
  });

  await t.test(
    "window button colours come only from the app, as hex",
    async () => {
      setup(async () => ({ ok: true, port: 5258 }));
      const setColors = handlers.get("covel:title-bar:set-colors");
      const colors = { background: "#f2ece3", foreground: "#1c140e" };
      await setColors(
        { senderFrame: { url: "https://untrusted.example" } },
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
  const { createServerRecovery, findStartablePort } = await import(
    pathToFileURL(output).href
  );
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
});
