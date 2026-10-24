import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nextSettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import { findPreferredPort } from "../src/network.ts";
import { verifyArtifactUi } from "./artifact-ui-smoke.mjs";

// Reuse the repository's Playwright tool, not a desktop runtime dependency.
let chromium;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const evidenceRoot = path.join(root, "debugs/windows-artifact-smoke");
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;

async function waitForExit(completed, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      completed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}

async function runArtifact(kind, artifact, version, evidence) {
  const temporary = await mkdtemp(path.join(tmpdir(), "Covel shipped 汉字 "));
  const home = path.join(temporary, "home");
  const userData = path.join(temporary, "user data");
  const extractionTemp = path.join(temporary, "temp");
  const stop = path.join(temporary, "stop");
  const captureDesktop = path.join(temporary, "capture-desktop");
  let supervisor;
  let completed;
  let supervisorResult;
  let browser;
  let page;
  let failure;
  let output = "";
  const cleanupErrors = [];
  const started = Date.now();
  try {
    await Promise.all(
      [home, userData, extractionTemp, evidence].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    // Only select the UI language. Exercise the real first-run guide and real
    // bundled worlds; no routes, backend responses or readiness are mocked.
    await writeFile(
      path.join(home, "settings.json"),
      JSON.stringify(
        nextSettingsPersistenceBundle(
          { "ui.locale": "en-US", "ui.appearance": "panel" },
          0,
        ),
      ),
    );
    let executable = artifact;
    if (kind === "zip") {
      const extracted = path.join(temporary, "extracted app");
      await exec(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quotePowerShell(artifact)} -DestinationPath ${quotePowerShell(extracted)}`,
        ],
        { timeout: 120_000 },
      );
      executable = path.join(extracted, "Covel.exe");
      await access(executable);
      await access(path.join(extracted, "resources/app.asar"));
      // Verify the shipped ZIP after extraction into a Unicode/spaced path,
      // including RunAsNode, SQLite/vec and plugin loading under Covel.exe.
      for (const flags of [[], ["--no-llm-toml"]]) {
        let result;
        try {
          result = await exec(
            process.execPath,
            [
              path.join(desktop, "scripts/verify-staging.mjs"),
              "--resources",
              path.join(extracted, "resources"),
              "--platform",
              "win32",
              "--arch",
              "x64",
              ...flags,
            ],
            { timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          );
        } catch (error) {
          result = error;
          throw error;
        } finally {
          await writeFile(
            path.join(
              evidence,
              flags.length ? "backend-default.log" : "backend-configured.log",
            ),
            (result?.stdout ?? "") + (result?.stderr ?? ""),
          );
        }
      }
      await writeFile(
        path.join(evidence, "size.json"),
        JSON.stringify(
          {
            artifactBytes: (await stat(artifact)).size,
            unpackedBytes: await directoryBytes(extracted),
            backend: "packaged Covel.exe (Electron RunAsNode)",
          },
          null,
          2,
        ),
      );
    } else {
      await writeFile(
        path.join(evidence, "size.json"),
        JSON.stringify(
          {
            artifactBytes: (await stat(artifact)).size,
          },
          null,
          2,
        ),
      );
    }
    const port = await findPreferredPort(undefined);
    const config = path.join(temporary, "launch.json");
    await writeFile(
      config,
      JSON.stringify({
        executable,
        arguments: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --user-data-dir="${userData}" --lang=en-US --enable-logging=file --log-file="${path.join(evidence, "chromium.log")}"`,
        cwd: path.dirname(executable),
        portable: kind === "portable",
        stop,
        evidence,
        captureDesktop,
        splash: path.join(desktop, "resources/portable-splash.bmp"),
      }),
    );
    const env = {
      ...process.env,
      COVEL_HOME: home,
      APPDATA: path.join(temporary, "appdata"),
      LOCALAPPDATA: path.join(temporary, "localappdata"),
      TEMP: extractionTemp,
      TMP: extractionTemp,
    };
    // The run must not pick up a developer's launch mode, data path or keys.
    for (const key of Object.keys(env)) {
      if (
        (/^(?:COVEL_|DEFAULT_|PROVIDER_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|SQLITE_PATH$|DATABASE_URL$|STORE_BACKEND$|SERVER_PORT$)/i.test(
          key,
        ) ||
          /_API_KEY$/i.test(key)) &&
        key !== "COVEL_HOME"
      )
        delete env[key];
    }
    await Promise.all(
      [env.APPDATA, env.LOCALAPPDATA].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    supervisor = spawn(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(desktop, "scripts/windows-smoke-launch.ps1"),
        "-Config",
        config,
      ],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    supervisor.stdout.on("data", (chunk) => {
      output += chunk;
    });
    supervisor.stderr.on("data", (chunk) => {
      output += chunk;
    });
    completed = new Promise((resolve) => {
      supervisor.once("error", (error) => {
        supervisorResult = { error };
        resolve(supervisorResult);
      });
      supervisor.once("exit", (code, signal) => {
        supervisorResult = { code, signal };
        resolve(supervisorResult);
      });
    });
    const connectDeadline = Date.now() + 120_000;
    let connectError;
    while (Date.now() < connectDeadline && !supervisorResult) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1_000,
        });
        break;
      } catch (error) {
        connectError = error;
        await sleep(250);
      }
    }
    // Preserve launcher diagnostics even when the first observable failure is
    // inability to connect to the Electron debugger.
    await writeFile(path.join(evidence, "launcher.log"), output);
    if (!browser)
      throw new Error(
        `No shipped Electron debugger (${kind}); supervisor=${JSON.stringify(supervisorResult)}\n${output}`,
        { cause: connectError },
      );
    const context = browser.contexts()[0];
    assert.ok(context, "Shipped Electron must expose its real browser context");
    page =
      context.pages()[0] ??
      (await context.waitForEvent("page", { timeout: 30_000 }));
    await verifyArtifactUi(page, version, evidence);
    if (kind === "portable") {
      const native = await readJson(
        path.join(evidence, "native-preparation.json"),
      );
      assert.ok(
        native.observedMs >= 0,
        "Actual native preparation must be visible before readiness",
      );
    }
    // CDP can render and screenshot a hidden BrowserWindow. Require a native,
    // non-minimized HWND in this launch's job and an actual screen capture too.
    await writeFile(captureDesktop, "renderer reached actionable session prep");
    const visibleDeadline = Date.now() + 10_000;
    let desktopWindow;
    while (Date.now() < visibleDeadline && !supervisorResult) {
      try {
        desktopWindow = await readJson(
          path.join(evidence, "desktop-window.json"),
        );
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await sleep(100);
      }
    }
    assert.ok(
      desktopWindow,
      "Renderer is ready but no displayed, non-minimized owned Electron HWND was observed on the Windows desktop",
    );
    await access(path.join(evidence, "desktop-window.png"));
    await writeFile(
      path.join(evidence, "ready.json"),
      JSON.stringify(
        {
          artifact,
          url: page.url(),
          version,
          elapsedMs: Date.now() - started,
          desktopWindow,
          // Includes ZIP extraction for the ZIP variant; not a startup benchmark.
          reached: "bundled-world session preparation",
        },
        null,
        2,
      ),
    );
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close");
    const result = await waitForExit(completed, 15_000);
    assert.ok(
      result,
      "Shipped app and its sidecar must exit within 15 seconds",
    );
    assert.equal(result.code, 0, `Native observer failed: ${output}`);
    assert.equal(
      (await readJson(path.join(evidence, "exited.json"))).exitCode,
      0,
    );
    await writeFile(path.join(evidence, "launcher.log"), output);
    console.log(
      `${kind}: actual shipped entry reached world selection/preparation and exited cleanly`,
    );
  } catch (error) {
    failure = error;
    await writeFile(
      path.join(evidence, "failure.txt"),
      error.stack ?? String(error),
    ).catch(() => {});
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: path.join(evidence, "failure.png"),
          timeout: 3_000,
        })
        .catch(() => {});
  } finally {
    // Cleanup errors never replace the original startup/UI assertion.
    if (supervisor && !supervisorResult) {
      await writeFile(stop, "stop").catch((error) => cleanupErrors.push(error));
      if (!(await waitForExit(completed, 5_000))) {
        supervisor.kill(); // Closing its job handle kills only this run's tree.
        await waitForExit(completed, 5_000);
      }
    }
    await writeFile(path.join(evidence, "launcher.log"), output).catch(
      (error) => cleanupErrors.push(error),
    );
    if (failure)
      await cp(home, path.join(evidence, "home"), { recursive: true }).catch(
        (error) => cleanupErrors.push(error),
      );
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    }).catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length) {
      await writeFile(
        path.join(evidence, "cleanup-errors.txt"),
        cleanupErrors.map(String).join("\n"),
      ).catch((error) =>
        console.error("Could not preserve cleanup diagnostics:", error),
      );
    }
  }
  if (failure) throw failure;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Windows smoke cleanup failed");
}

try {
  assert.equal(
    process.platform,
    "win32",
    "Requires native Windows with an interactive, unlocked desktop; no emulated success",
  );
  assert.equal(process.arch, "x64");
  ({ chromium } = createRequire(
    new URL("../../../package.json", import.meta.url),
  )("playwright"));
  const { version } = await readJson(path.join(desktop, "package.json"));
  await mkdir(evidenceRoot, { recursive: true });
  const run = await mkdtemp(path.join(evidenceRoot, "run-"));
  console.log(`Windows shipped-artifact evidence: ${run}`);
  for (const [kind, suffix] of [
    ["zip", "win-x64.zip"],
    ["portable", "win-x64-portable.exe"],
  ]) {
    const artifact = path.join(
      root,
      "release/electron",
      `Covel-electron-${version}-${suffix}`,
    );
    await access(artifact);
    await runArtifact(kind, artifact, version, path.join(run, kind));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
