import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

import { spawnCommand } from "./lib/command-shim.mjs";

const repoRoot = process.cwd();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CI: process.env.CI ?? "true",
    };
    const child = spawnCommand(
      command,
      args,
      {
        stdio: "inherit",
        cwd: repoRoot,
        env,
      },
      { spawnImpl: spawn, env },
    );

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`),
      );
    });
  });
}

fs.rmSync(path.join(repoRoot, "apps/web/src/routeTree.gen.ts"), {
  force: true,
});

await run("pnpm", ["install", "--frozen-lockfile"]);
await run("pnpm", ["clean"]);
await run("pnpm", ["lint"]);
// Dependency hygiene: fail CI on unused / missing workspace dependencies so the
// stale-declaration drift this codebase accumulated cannot silently return.
// knip understands JSDoc `import()` type refs + test files, so it does not flag
// type-only or test-only deps as unused (which a naive depcheck would).
await run("pnpm", ["deps:check"]);
