import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { isDocsOnly } from "./lib/change-scope.mjs";
import { selectTests } from "./lib/push-scope.mjs";

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

// The hook gets no flags from `git push`, so the variable asks for every
// suite there; `pnpm check:push --full` does the same by hand.
const wantsFullRun =
  process.argv.includes("--full") || env.COVEL_PUSH_CHECK === "full";
const fullRunHint =
  "COVEL_PUSH_CHECK=full or pnpm check:push --full runs them here";

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
// A cache directory set by the caller wins.
if (!env.TURBO_CACHE_DIR && path.basename(commonDir) === ".git") {
  env.TURBO_CACHE_DIR = path.join(path.dirname(commonDir), ".turbo", "cache");
}

/** The local ref that tracks the main branch of `remote`. */
function remoteMainRef(remote) {
  try {
    return git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  } catch {
    // The remote has no recorded default branch.
    return `refs/remotes/${remote}/main`;
  }
}

/**
 * The commit a branch on `remote` is measured from: where it left the
 * remote's main branch. A clone that never fetched that branch fetches it
 * once; a stale copy only makes the measured change larger.
 */
function remoteMainBase(commit, remote) {
  if (!remote) return undefined;
  const main = remoteMainRef(remote);
  try {
    return git(["merge-base", commit, main]);
  } catch {
    // Unknown ref: fetch it below.
  }
  try {
    execFileSync("git", ["fetch", "--quiet", remote, "main"], {
      cwd: repoRoot,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdio: "ignore",
      timeout: 30_000,
    });
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
    return isDocsOnly(changedFiles(base, commit));
  } catch {
    return false;
  }
}

function changedFiles(base, commit) {
  // Without rename detection a moved file lists both of its paths.
  return git(["diff", "--name-only", "--no-renames", base, commit])
    .split("\n")
    .filter(Boolean);
}

/**
 * Why a push runs every test suite whatever it changed, or undefined: the
 * caller asked, or the ref is the remote's main branch or a tag.
 */
function fullRunReason(remoteRef, remote) {
  if (wantsFullRun) return "a full run was requested";
  if (!remoteRef) return undefined;
  if (remoteRef.startsWith("refs/tags/")) return "a tag is pushed";
  const main = remoteMainRef(remote ?? "origin")
    .split("/")
    .at(-1);
  if (remoteRef === `refs/heads/${main}` || remoteRef === "refs/heads/main") {
    return "the main branch is pushed";
  }
  return undefined;
}

function pushedCommits(input, remote) {
  // A commit pushed to several refs is documentation only when it is for each,
  // and runs every suite when one of them asks for it.
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
    const [, localSha, remoteRef, remoteSha] = fields;
    if (/^0+$/.test(localSha) || localSha === remoteSha) continue;
    const commit = git(["rev-parse", "--verify", `${localSha}^{commit}`]);
    const known = commits.get(commit);
    commits.set(commit, {
      docsOnly:
        (known?.docsOnly ?? true) && addsOnlyDocs(commit, remoteSha, remote),
      fullRun: known?.fullRun ?? fullRunReason(remoteRef, remote),
    });
  }
  return [...commits].map(([commit, scope]) => ({ commit, remote, ...scope }));
}

/** The workspace packages of a checkout, from pnpm-workspace.yaml. */
function workspacePackages(checkout) {
  // The list under `packages:`; any other layout of the file yields nothing.
  const list = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(
    readFileSync(path.join(checkout, "pnpm-workspace.yaml"), "utf8"),
  );
  const patterns = (list?.[1] ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\s*-\s*/, "").replace(/^["']|["']\s*$/g, ""));
  const found = [];
  for (const pattern of patterns) {
    const parent = /^([^*!]+)\/\*$/.exec(pattern)?.[1];
    // Another form of pattern: the packages cannot be listed here.
    if (!parent) return [];
    const directory = path.join(checkout, parent);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const manifest = path.join(directory, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name) found.push({ dir: `${parent}/${entry.name}`, name });
    }
  }
  return found;
}

/**
 * The test suites the pushed commit can break, measured from where the branch
 * left the remote's main branch. Any doubt selects every suite.
 */
function affectedTests(checkout, { commit, remote, fullRun, base: from }) {
  if (fullRun) return { full: true, reason: fullRun };
  let base;
  try {
    // `--base` names the branch a stacked branch was started from.
    base = from
      ? git(["merge-base", commit, from])
      : remoteMainBase(commit, remote ?? "origin");
  } catch {
    // An unknown ref is no base.
  }
  if (!base) {
    return {
      full: true,
      reason: from
        ? `${from} is not a known commit`
        : "the remote's main branch is unknown",
    };
  }
  try {
    return selectTests({
      files: changedFiles(base, commit),
      packages: workspacePackages(checkout),
      turbo: JSON.parse(
        readFileSync(path.join(checkout, "turbo.json"), "utf8"),
      ),
    });
  } catch {
    return { full: true, reason: "the workspace could not be read" };
  }
}

function hasScript(checkout, name) {
  try {
    const manifest = readFileSync(path.join(checkout, "package.json"), "utf8");
    return typeof JSON.parse(manifest).scripts?.[name] === "string";
  } catch {
    return false;
  }
}

/**
 * The commits this worktree checked in the last hours. `git push` connects to
 * the remote before it runs the hook and the connection carries nothing while
 * the hook works, so a remote or a proxy can close it: the push then fails
 * after the checks passed. The next push of the same commit, or a push after
 * `pnpm check:push`, finds the commit here and sends at once.
 */
const verifiedFile = path.resolve(
  repoRoot,
  git(["rev-parse", "--git-path", "covel-push-verified.json"]),
);
const VERIFIED_FOR_MS = 12 * 60 * 60 * 1000;
const LEVELS = ["docs", "affected", "full"];

function readVerified() {
  try {
    const entries = JSON.parse(readFileSync(verifiedFile, "utf8"));
    return entries.filter(
      (entry) =>
        LEVELS.includes(entry.level) &&
        Date.now() - Date.parse(entry.at) < VERIFIED_FOR_MS,
    );
  } catch {
    return [];
  }
}

/** An earlier check of `commit` that ran at least what this push needs. */
function verifiedEarlier(commit, needed) {
  return readVerified().find(
    (entry) =>
      entry.commit === commit &&
      LEVELS.indexOf(entry.level) >= LEVELS.indexOf(needed),
  );
}

function recordVerified(commit, result) {
  try {
    const entries = readVerified().filter(
      (entry) =>
        entry.commit !== commit ||
        LEVELS.indexOf(entry.level) > LEVELS.indexOf(result.level),
    );
    entries.push({ commit, ...result, at: new Date().toISOString() });
    writeFileSync(verifiedFile, `${JSON.stringify(entries.slice(-50))}\n`);
  } catch {
    // The record only saves a repeated run.
  }
}

/** Runs the checks for one pushed commit and returns what ran, in words. */
function verifyCommit(pushed) {
  const { commit, docsOnly } = pushed;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "covel-push-"));
  const checkout = path.join(scratch, "checkout");
  try {
    console.log(`\nChecking pushed commit ${commit} in a clean checkout.`);
    git(["clone", "--quiet", "--shared", "--no-checkout", repoRoot, checkout]);
    git(["checkout", "--quiet", "--detach", commit], checkout);
    // Run the static gate before tests can create artifacts that mask missing
    // files. Do not copy node_modules, .env, or build output.
    const commands = [["install", "--frozen-lockfile"], ["check"]];
    let ran;
    let left = "PostgreSQL integration, browser smoke, the build";
    let level = "full";
    // The commands run in the pushed commit. One from before `test:docs`
    // existed has no short path.
    if (docsOnly && hasScript(checkout, "test:docs")) {
      console.log(
        "Only documentation changed: running the static gate and the tests that read documentation.",
      );
      commands.push(["test:docs"]);
      ran = "the static gate and the tests that read documentation";
      left = "nothing this push can change";
      level = "docs";
    } else {
      const scope = affectedTests(checkout, pushed);
      if (scope.full) {
        console.log(`Running every test suite: ${scope.reason}.`);
        commands.push(["test", "--concurrency=2"]);
        ran = "the static gate, every test suite, the E2E listing";
      } else {
        if (scope.filters.length > 0) {
          commands.push([
            "test",
            "--concurrency=2",
            ...scope.filters.map((filter) => `--filter=${filter}`),
          ]);
        }
        if (scope.docs && hasScript(checkout, "test:docs")) {
          commands.push(["test:docs"]);
        }
        ran =
          scope.filters.length > 0
            ? `the static gate, the tests of ${scope.filters.join(" ")} (a leading ... adds the packages that depend on it), the E2E listing`
            : "the static gate and the E2E listing; no test suite reads the changed files";
        left = `the other test suites (${fullRunHint}), PostgreSQL integration, browser smoke, the build`;
        level = "affected";
      }
      commands.push(["e2e", "--list"]);
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
    return { ran, left, level };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const fromHook = process.argv[2] === "--pre-push";
  const commits = fromHook
    ? pushedCommits(readFileSync(0, "utf8"), process.argv[3])
    : [
        {
          commit: git(["rev-parse", "--verify", "HEAD^{commit}"]),
          docsOnly: false,
          fullRun: fullRunReason(),
          base: process.argv.includes("--base")
            ? process.argv[process.argv.indexOf("--base") + 1]
            : undefined,
        },
      ];
  let result;
  for (const pushed of commits) {
    const needed = pushed.docsOnly
      ? "docs"
      : pushed.fullRun
        ? "full"
        : "affected";
    // A run by hand or a requested full run always runs.
    const earlier =
      fromHook && !wantsFullRun && verifiedEarlier(pushed.commit, needed);
    if (earlier) {
      const minutes = Math.round((Date.now() - Date.parse(earlier.at)) / 60000);
      console.log(
        `Commit ${pushed.commit.slice(0, 12)} passed its checks ${minutes} min ago; they are not run again.`,
      );
      result = earlier;
      continue;
    }
    result = verifyCommit(pushed);
    recordVerified(pushed.commit, result);
  }
  // The last one stands for the push: several tips in one push are rare.
  if (result) {
    console.log(
      `\nPre-push checks passed. Ran: ${result.ran}.\nLeft to CI: ${result.left}.`,
    );
  }
} catch (error) {
  console.error(`[pre-push] ${error.message}`);
  process.exitCode = 1;
}
