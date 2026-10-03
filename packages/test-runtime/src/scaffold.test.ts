import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePluginLabels } from "@covel/plugin-loader";
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
    {
      mode: "agent-only",
      args: ["-r", "analyst:agent"],
      directory: "home/plugins",
    },
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
        const pluginRoot = path.join(root, directory, pluginId);
        // A new plugin starts on the current contract: manifests and prompts
        // in English, translated labels in locales/.
        const manifests = (await readdir(pluginRoot, { recursive: true }))
          .filter((file) =>
            /^(PLUGIN|RUNTIME)(\..+)?\.md$/.test(path.basename(file)),
          )
          .sort();
        expect(manifests).toContain("PLUGIN.md");
        for (const file of manifests) {
          expect(path.basename(file), file).toMatch(/^(PLUGIN|RUNTIME)\.md$/);
          expect(
            await readFile(path.join(pluginRoot, file), "utf8"),
            file,
          ).not.toMatch(/[\u4e00-\u9fff]/);
        }
        expect(await validatePluginLabels(pluginRoot)).toEqual([]);
        expect(
          await readFile(path.join(pluginRoot, "locales/zh.yaml"), "utf8"),
        ).toMatch(/^PLUGIN\.md:\n {2}description: .*[\u4e00-\u9fff]/m);
        if (mode !== "with-tools") {
          // Plugins scaffolded outside the repo carry no install step: the
          // author SDK is a workspace package, not an npm dependency.
          const manifest = JSON.parse(
            await readFile(path.join(pluginRoot, "package.json"), "utf8"),
          );
          expect(manifest.scripts).toBeUndefined();
          expect(manifest.dependencies).toBeUndefined();
          expect(manifest.devDependencies).toBeUndefined();
        } else {
          await mkdir(path.join(pluginRoot, "node_modules/@covel"), {
            recursive: true,
          });
          await symlink(
            path.join(repoRoot, "packages/plugin-handlers-utils"),
            path.join(pluginRoot, "node_modules/@covel/plugin-handlers-utils"),
            "dir",
          );
          const compiler = path.join(
            repoRoot,
            "packages/test-runtime/node_modules/typescript/bin/tsc",
          );
          const check = () =>
            spawnSync(
              process.execPath,
              [compiler, "--noEmit", "-p", pluginRoot],
              { encoding: "utf8", timeout: 10000 },
            );
          const checked = check();
          expect(checked.status, checked.stdout + checked.stderr).toBe(0);
          const handlerPath = path.join(pluginRoot, "tools/record-note.js");
          const handlerSource = await readFile(handlerPath, "utf8");
          const invalidSource = handlerSource.replace(
            "params.title",
            "params.missingTitle",
          );
          expect(invalidSource).not.toBe(handlerSource);
          await writeFile(handlerPath, invalidSource, "utf8");
          const rejected = check();
          expect(rejected.status).not.toBe(0);
          expect(rejected.stdout).toContain("missingTitle");
          await writeFile(handlerPath, handlerSource, "utf8");
        }
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
