import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const env = { ...process.env, CI: "true", VITEST_MAX_WORKERS: "2" };
// Hooks can inherit Git paths and developer database settings. Neither belongs
// in the disposable checkout used to validate the committed source.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")) {
  delete env[name];
}
delete env.DATABASE_URL;
delete env.COVEL_REQUIRE_PG_TESTS;
delete env.NODE_ENV;

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function pushedCommits(input) {
  const commits = new Set();
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 4 ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[3])
    ) {
      throw new Error("Invalid Git pre-push input.");
    }
    const [, localSha, , remoteSha] = fields;
    if (/^0+$/.test(localSha) || localSha === remoteSha) continue;
    commits.add(git(["rev-parse", "--verify", `${localSha}^{commit}`]));
  }
  return [...commits];
}

function verifyCommit(commit) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "covel-push-"));
  const checkout = path.join(scratch, "checkout");
  try {
    console.log(`\nChecking pushed commit ${commit} in a clean checkout.`);
    git(["clone", "--quiet", "--shared", "--no-checkout", repoRoot, checkout]);
    git(["checkout", "--quiet", "--detach", commit], checkout);
    // Run the static gate before tests can create artifacts that mask missing
    // files. Do not copy node_modules, .env, build output, or Turbo caches.
    const commands = [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test", "--concurrency=2"],
      ["e2e", "--list"],
    ];
    for (const args of commands) {
      console.log(`\n[pre-push] pnpm ${args.join(" ")}`);
      const result = crossSpawn.sync("pnpm", args, {
        cwd: checkout,
        env,
        stdio: "inherit",
        timeout: 25 * 60 * 1000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          `pnpm ${args.join(" ")} failed (${result.signal ?? result.status}). Push blocked.`,
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const commits =
    process.argv[2] === "--pre-push"
      ? pushedCommits(readFileSync(0, "utf8"))
      : [git(["rev-parse", "--verify", "HEAD^{commit}"])];
  for (const commit of commits) verifyCommit(commit);
  if (commits.length > 0) {
    console.log(
      "\nPre-push checks passed. PostgreSQL integration, browser smoke, and packaging remain separate checks.",
    );
  }
} catch (error) {
  console.error(`[pre-push] ${error.message}`);
  process.exitCode = 1;
}
