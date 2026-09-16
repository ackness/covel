import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import electron from "electron";

// Opt-in native smoke test. Uses the real window guard, IPC handler, preload,
// and renderer bridge with two local HTTP fixtures and isolated user data.
const root = await mkdtemp(path.join(tmpdir(), "covel-native-restart-"));
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = path.resolve(desktopRoot, "../web");
try {
  await build({
    entryPoints: [path.join(desktopRoot, "src/preload.ts")],
    outfile: path.join(root, "preload.mjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["electron"],
  });
  await build({
    entryPoints: [path.join(webRoot, "src/lib/desktop-bridge.ts")],
    outfile: path.join(root, "bridge.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    tsconfig: path.join(webRoot, "tsconfig.json"),
  });
  await build({
    stdin: {
      resolveDir: desktopRoot,
      contents: `
        import assert from "node:assert/strict";
        import { createServer } from "node:http";
        import { once } from "node:events";
        import { readFile } from "node:fs/promises";
        import { app } from "electron";
        import { createMainWindow } from "./src/windows.ts";
        import { registerDesktopIpcHandlers } from "./src/ipc-handlers.ts";
        import { version } from "./package.json";

        app.setPath("userData", process.env.COVEL_HOME);
        void (async () => {
        const servers = [];
        let win;
        try {
          await app.whenReady();
          const bridge = await readFile(new URL("./bridge.js", import.meta.url));
          const start = async (label) => {
            const server = createServer((req, res) => {
              if (req.url === "/bridge.js") {
                res.setHeader("Content-Type", "text/javascript");
                return res.end(bridge);
              }
              res.setHeader("Content-Type", "text/html");
              res.end('<h1>' + label + '</h1><button id="restart">Restart</button>' +
                '<script type="module">import { reloadServerAndWait } from "/bridge.js";' +
                'window.probeReady = true; document.getElementById("restart").onclick = () => reloadServerAndWait();</script>');
            });
            servers.push(server);
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            return server;
          };
          const old = await start("Old sidecar");
          const next = await start("Restarted sidecar");
          const oldPort = old.address().port;
          const newPort = next.address().port;
          assert.notEqual(oldPort, newPort);
          registerDesktopIpcHandlers({
            paths: {}, isDev: false,
            restartServer: async () => {
              old.closeAllConnections();
              await new Promise((resolve) => old.close(resolve));
              return { ok: true, port: newPort };
            },
          });
          win = createMainWindow("Restart smoke");
          await win.loadURL("http://127.0.0.1:" + oldPort + "/session");
          await win.webContents.executeJavaScript(
            'new Promise(resolve => { const check = () => window.probeReady ? resolve() : setTimeout(check, 10); check(); })'
          );
          assert.equal(await win.webContents.executeJavaScript('window.covelIpc.appVersion'), version);
          const loaded = once(win.webContents, "did-finish-load");
          await win.webContents.executeJavaScript('document.getElementById("restart").click()');
          await loaded;
          assert.equal(win.webContents.getURL(), "http://127.0.0.1:" + newPort + "/session");
          assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), "Restarted sidecar");
          assert.equal(await win.webContents.executeJavaScript('window.covelIpc.appVersion'), version);
          console.log("Native restart navigation OK: new port loaded through real IPC and origin guard");
          win.destroy();
          servers.forEach(server => { server.closeAllConnections(); server.close(); });
          app.exit(0);
        } catch (error) {
          console.error(error);
          win?.destroy();
          servers.forEach(server => { server.closeAllConnections(); server.close(); });
          app.exit(1);
        }
        })();
      `,
    },
    outfile: path.join(root, "main.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["electron"],
  });
  const env = { ...process.env, COVEL_HOME: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.COVEL_APP_VERSION;
  const { stdout, stderr } = await promisify(execFile)(
    electron,
    [path.join(root, "main.mjs")],
    {
      env,
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(root, { recursive: true, force: true });
}
