import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { nextSettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import { findPreferredPort } from "../src/network.ts";
import { verifyArtifactUi } from "./artifact-ui-smoke.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (groupExists(pid) && Date.now() < deadline) await delay(100);
  return !groupExists(pid);
}

async function smoke() {
  assert.equal(
    process.platform,
    "darwin",
    "Requires native macOS with a GUI session",
  );
  assert.equal(process.arch, "arm64", "Official macOS artifacts target arm64");
  const { chromium } = createRequire(
    new URL("../../../package.json", import.meta.url),
  )("playwright");
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const artifact = path.join(
    root,
    "release/electron",
    `Covel-electron-${version}-mac-arm64.zip`,
  );
  await access(artifact);
  const evidenceRoot = path.join(root, "debugs/mac-artifact-smoke");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(path.join(evidenceRoot, "run-"));
  console.log(`macOS shipped-artifact evidence: ${evidence}`);
  const temporary = await mkdtemp(path.join(tmpdir(), "Covel shipped 汉字 "));
  const home = path.join(temporary, "home");
  let child;
  let result;
  let page;
  let output = "";
  let failure;
  const cleanupErrors = [];
  try {
    await mkdir(home);
    await writeFile(
      path.join(home, "settings.json"),
      JSON.stringify(
        nextSettingsPersistenceBundle(
          { "ui.locale": "en-US", "ui.appearance": "panel" },
          0,
        ),
      ),
    );
    const extracted = path.join(temporary, "extracted app");
    await mkdir(extracted);
    await exec("/usr/bin/ditto", ["-x", "-k", artifact, extracted], {
      timeout: 120_000,
    });
    const app = path.join(extracted, "Covel.app");
    const resources = path.join(app, "Contents/Resources");
    const executable = path.join(app, "Contents/MacOS/Covel");
    await access(executable);
    // Verify the ZIP's own ASAR, runtime and backend before testing its GUI.
    for (const flags of [[], ["--no-llm-toml"]]) {
      let backend;
      try {
        backend = await exec(
          process.execPath,
          [
            path.join(root, "apps/desktop/scripts/verify-staging.mjs"),
            "--resources",
            resources,
            "--platform",
            "darwin",
            "--arch",
            "arm64",
            ...flags,
          ],
          { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
        );
      } catch (error) {
        backend = error;
        throw error;
      } finally {
        await writeFile(
          path.join(
            evidence,
            flags.length ? "backend-default.log" : "backend-configured.log",
          ),
          (backend?.stdout ?? "") + (backend?.stderr ?? ""),
        );
      }
    }
    const port = await findPreferredPort(undefined);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        /^(?:COVEL_|DEFAULT_|PROVIDER_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|SQLITE_PATH$|DATABASE_URL$|STORE_BACKEND$|SERVER_PORT$)/i.test(
          key,
        ) ||
        /_API_KEY$/i.test(key)
      )
        delete env[key];
    }
    env.COVEL_HOME = home;
    child = spawn(
      executable,
      [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${path.join(temporary, "user data")}`,
        "--lang=en-US",
        "--enable-logging=file",
        `--log-file=${path.join(evidence, "chromium.log")}`,
      ],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const completed = new Promise((resolve) => {
      child.once("error", (error) => {
        result = { error };
        resolve(result);
      });
      child.once("exit", (code, signal) => {
        result = { code, signal };
        resolve(result);
      });
    });
    const deadline = Date.now() + 90_000;
    let browser;
    let connectError;
    while (!result && Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1_000,
        });
        break;
      } catch (error) {
        connectError = error;
        await delay(250);
      }
    }
    assert.ok(
      browser,
      `No shipped macOS Electron debugger: ${JSON.stringify(result)}\n${connectError}\n${output}`,
    );
    const context = browser.contexts()[0];
    assert.ok(context, "Shipped Electron must expose its real browser context");
    page =
      context.pages()[0] ??
      (await context.waitForEvent("page", { timeout: 30_000 }));
    await verifyArtifactUi(page, version, evidence);
    const url = page.url();
    const session = await browser.newBrowserCDPSession();
    // Electron can exit before acknowledging Browser.close. The native exit
    // event is authoritative; never leave a CDP reply as an unbounded await.
    let closeError;
    void session.send("Browser.close").catch((error) => {
      closeError = error;
    });
    let exitTimer;
    try {
      await Promise.race([
        completed,
        new Promise((_, reject) => {
          exitTimer = setTimeout(
            () =>
              reject(
                new Error("Shipped app did not exit within 15 seconds", {
                  cause: closeError,
                }),
              ),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
    assert.ok(
      await waitForGroupExit(child.pid, 5_000),
      "Shipped app exited but its process group is still running",
    );
    assert.equal(
      result?.code,
      0,
      `Shipped macOS app failed to exit cleanly: ${JSON.stringify(result)}\n${output}`,
    );
    await writeFile(
      path.join(evidence, "ready.json"),
      JSON.stringify(
        {
          artifact,
          version,
          url,
          reached: "bundled-world session preparation and reload",
          exitCode: result.code,
        },
        null,
        2,
      ),
    );
    console.log(
      "macOS ZIP: shipped app reached world selection/preparation, reloaded and exited cleanly",
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
    // A dedicated process group keeps cleanup scoped to this launch, including
    // an orphaned backend if the GUI crashed. Never delete its data while alive.
    if (child?.pid) {
      try {
        if (groupExists(child.pid)) {
          process.kill(-child.pid, "SIGTERM");
          if (!(await waitForGroupExit(child.pid, 5_000))) {
            process.kill(-child.pid, "SIGKILL");
            assert.ok(
              await waitForGroupExit(child.pid, 5_000),
              "Smoke process group did not exit",
            );
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await writeFile(path.join(evidence, "launcher.log"), output).catch(
      (error) => cleanupErrors.push(error),
    );
    if (failure)
      await cp(home, path.join(evidence, "home"), { recursive: true }).catch(
        (error) => cleanupErrors.push(error),
      );
    if (!cleanupErrors.length)
      await rm(temporary, { recursive: true, force: true }).catch((error) =>
        cleanupErrors.push(error),
      );
    if (cleanupErrors.length)
      await writeFile(
        path.join(evidence, "cleanup-errors.txt"),
        `Preserved temporary directory: ${temporary}\n${cleanupErrors.map(String).join("\n")}`,
      ).catch(console.error);
  }
  if (failure) throw failure;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "macOS smoke cleanup failed");
}

try {
  await smoke();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
