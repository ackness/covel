import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { isDocsOnly } from "./lib/change-scope.mjs";

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

// Turbo replays a task from the cache every worktree of this repository
// shares. A hit needs the same tracked inputs, so it stands for a run on this
// commit's files and the clean checkout still catches a file that was never
// committed. What a hit cannot show is a result that depended on a file Git
// ignores; CI, which starts with no local files, covers that.
const commonDir = git([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
if (path.basename(commonDir) === ".git") {
  env.TURBO_CACHE_DIR = path.join(path.dirname(commonDir), ".turbo", "cache");
}

/** The commit a new branch on `remote` is measured from. */
function remoteMainBase(commit, remote) {
  if (!remote) return undefined;
  try {
    let main = `refs/remotes/${remote}/main`;
    try {
      main = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    } catch {
      // The remote has no recorded default branch.
    }
    return git(["merge-base", commit, main]);
  } catch {
    return undefined;
  }
}

/**
 * Whether everything a push adds to the remote ref is documentation. What the
 * remote already has was verified when it was pushed; a new branch is measured
 * from the remote's main branch. Any doubt counts as code.
 */
function addsOnlyDocs(commit, remoteSha, remote) {
  const base = /^0+$/.test(remoteSha)
    ? remoteMainBase(commit, remote)
    : remoteSha;
  if (!base) return false;
  try {
    // Without rename detection a file moved out of docs/ lists its new path.
    const files = git(["diff", "--name-only", "--no-renames", base, commit]);
    return isDocsOnly(files.split("\n").filter(Boolean));
  } catch {
    return false;
  }
}

function pushedCommits(input, remote) {
  // A commit pushed to several refs is documentation only when it is for each.
  const commits = new Map();
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
    const commit = git(["rev-parse", "--verify", `${localSha}^{commit}`]);
    commits.set(
      commit,
      (commits.get(commit) ?? true) && addsOnlyDocs(commit, remoteSha, remote),
    );
  }
  return [...commits].map(([commit, docsOnly]) => ({ commit, docsOnly }));
}

function hasScript(checkout, name) {
  try {
    const manifest = readFileSync(path.join(checkout, "package.json"), "utf8");
    return typeof JSON.parse(manifest).scripts?.[name] === "string";
  } catch {
    return false;
  }
}

function verifyCommit({ commit, docsOnly }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "covel-push-"));
  const checkout = path.join(scratch, "checkout");
  try {
    console.log(`\nChecking pushed commit ${commit} in a clean checkout.`);
    git(["clone", "--quiet", "--shared", "--no-checkout", repoRoot, checkout]);
    git(["checkout", "--quiet", "--detach", commit], checkout);
    // Run the static gate before tests can create artifacts that mask missing
    // files. Do not copy node_modules, .env, or build output.
    const commands = [["install", "--frozen-lockfile"], ["check"]];
    // The commands run in the pushed commit. One from before `test:docs`
    // existed has no short path.
    if (docsOnly && hasScript(checkout, "test:docs")) {
      console.log(
        "Only documentation changed: running the static gate and the tests that read documentation.",
      );
      commands.push(["test:docs"]);
    } else {
      commands.push(["test", "--concurrency=2"], ["e2e", "--list"]);
    }
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
      ? pushedCommits(readFileSync(0, "utf8"), process.argv[3])
      : [
          {
            commit: git(["rev-parse", "--verify", "HEAD^{commit}"]),
            docsOnly: false,
          },
        ];
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
