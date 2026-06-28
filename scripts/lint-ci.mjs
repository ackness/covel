import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const repoRoot = process.cwd();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: process.env.CI ?? "true",
      },
    });

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

await run(pnpmCommand, ["install", "--frozen-lockfile"]);
await run(pnpmCommand, ["clean"]);
await run(pnpmCommand, ["lint"]);
// Dependency hygiene: fail CI on unused / missing workspace dependencies so the
// stale-declaration drift this codebase accumulated cannot silently return.
// knip understands JSDoc `import()` type refs + test files, so it does not flag
// type-only or test-only deps as unused (which a naive depcheck would).
await run(pnpmCommand, ["deps:check"]);
