import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("destroying a window cancels the pending geometry write", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-window-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture.mjs");
  await writeFile(
    fixture,
    `
    export const screen = {};
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
  const { attachWindowStateTracking } = await import(
    pathToFileURL(output).href
  );
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
