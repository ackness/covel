import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runRuntimeCases } from "./runner.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("plugin scaffolding", () => {
  it.each([
    { mode: "default", args: [], directory: "home/plugins" },
    {
      mode: "custom",
      args: ["-r", "recorder:function,analyst:agent"],
      directory: "user-plugins",
    },
    { mode: "with-tools", args: ["--with-tools"], directory: "plugins" },
  ])(
    "runs the generated $mode plugin cases",
    async ({ mode, args, directory }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "covel-scaffold-"));
      try {
        await mkdir(path.join(root, "scripts"));
        await cp(
          path.join(repoRoot, "scripts/create-plugin.js"),
          path.join(root, "scripts/create-plugin.js"),
        );
        await cp(
          path.join(repoRoot, "templates"),
          path.join(root, "templates"),
          { recursive: true },
        );
        const pluginId = `fixture-${mode}`;
        execFileSync(
          process.execPath,
          ["scripts/create-plugin.js", pluginId, ...args],
          {
            cwd: root,
            env: {
              ...process.env,
              COVEL_HOME: path.join(root, "home"),
              COVEL_USER_PLUGINS_DIR:
                mode === "custom" ? path.join(root, directory) : "",
            },
            timeout: 10_000,
            stdio: "pipe",
          },
        );
        const report = await runRuntimeCases({
          pluginId,
          pluginsDir: path.join(root, directory),
          mode: "mock",
        });
        expect(report.cases.length).toBeGreaterThan(0);
        for (const entry of report.cases) {
          expect(entry.status, JSON.stringify(entry.result.assertions)).toBe(
            "passed",
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
