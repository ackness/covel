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
    export const app = {};
    export const BrowserWindow = {};
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
    export const buildKeysEnvPatch = () => {};
    export const loadKeysEnv = () => {};
    export const saveKeysEnv = () => {};
    export const importAsset = () => {};
    export const writeDataRoot = () => {};
    export const setDesktopLocaleFromSettings = () => {};
    export const t = (value) => value;
    export const isSettingsEntries = () => true;
    export const readSettingsBundle = () => {};
    export const writeSettingsEntriesAtomic = () => {};
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
                /^(electron|\.\/(env-files|import-assets|paths|windows|logging|main-i18n|settings-json)\.js)$/,
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
  const { handlers, navigation, window } = await import(
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
});
