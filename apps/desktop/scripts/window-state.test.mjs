import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

async function loadWindowState(t) {
  const root = await mkdtemp(path.join(tmpdir(), "covel-window-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture.mjs");
  await writeFile(
    fixture,
    `
    export const screen = { getAllDisplays: () => [{ bounds: { x: -1920, y: 0, width: 3840, height: 1080 } }] };
    export const covelHome = () => ${JSON.stringify(root)};
  `,
    "utf8",
  );
  const output = path.join(root, "window-state.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/window-state.ts", import.meta.url)),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "window-state-services",
        setup(builder) {
          builder.onResolve({ filter: /^(electron|\.\/paths\.js)$/ }, () => ({
            path: fixture,
            external: true,
          }));
        },
      },
    ],
  });
  return { root, ...(await import(pathToFileURL(output).href)) };
}

test("destroying a window cancels the pending geometry write", async (t) => {
  const { attachWindowStateTracking } = await loadWindowState(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const win = new EventEmitter();
  win.isMaximized = () => {
    throw new Error("Object has been destroyed");
  };
  attachWindowStateTracking(win);
  win.emit("resize");
  // BrowserWindow.destroy() skips close and emits closed directly.
  win.emit("closed");
  assert.doesNotThrow(() => t.mock.timers.tick(250));
});

test("invalid persisted geometry cannot reach the native window constructor", async (t) => {
  const { root, resolveInitialWindowOptions } = await loadWindowState(t);
  const defaults = {
    x: undefined,
    y: undefined,
    width: 1440,
    height: 900,
    initial: { maximize: false, fullScreen: false },
  };
  for (const state of [
    { width: "wide" },
    { width: {} },
    { height: null },
    { width: 0 },
    { height: -50 },
    { width: 10.5 },
    { height: 2 ** 40 },
    { x: "0", y: 0 },
    { x: 2 ** 40, y: 0 },
    { isMaximized: "false" },
    { isFullScreen: [] },
    [],
    "invalid",
  ]) {
    await writeFile(
      path.join(root, "window-state.json"),
      JSON.stringify({ version: 1, state }),
    );
    assert.deepEqual(
      resolveInitialWindowOptions(),
      defaults,
      JSON.stringify(state),
    );
  }
});

test("valid geometry restores on a secondary display and drops disconnected coordinates", async (t) => {
  const { root, resolveInitialWindowOptions } = await loadWindowState(t);
  const state = {
    x: -1400,
    y: 80,
    width: 1200,
    height: 800,
    isMaximized: true,
    isFullScreen: false,
  };
  await writeFile(
    path.join(root, "window-state.json"),
    JSON.stringify({ version: 1, state }),
  );
  assert.deepEqual(resolveInitialWindowOptions(), {
    x: -1400,
    y: 80,
    width: 1200,
    height: 800,
    initial: { maximize: true, fullScreen: false },
  });
  state.x = -6000;
  await writeFile(
    path.join(root, "window-state.json"),
    JSON.stringify({ version: 1, state }),
  );
  assert.deepEqual(resolveInitialWindowOptions(), {
    x: undefined,
    y: undefined,
    width: 1200,
    height: 800,
    initial: { maximize: true, fullScreen: false },
  });
});
