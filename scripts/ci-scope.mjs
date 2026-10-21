import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDocsOnly } from "./lib/change-scope.mjs";

const isCommit = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{40,64}$/.test(value) &&
  !/^0+$/.test(value);

// Deployment eligibility only: every nonrelease CI run still builds the site.
const siteInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  "mise.toml",
  "tsconfig.json",
  "turbo.json",
  "scripts/require-pnpm.mjs",
  "scripts/ci-scope.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/site.yml",
]);

const unknownSelection = (release = false) => ({
  scope: "full",
  site_deploy: !release,
});

/** One successful, nonempty diff selects suites and Pages deployment inputs. */
export function selectCiScope({ cwd, eventName, event, sha, release, commit }) {
  if (release || commit) return unknownSelection(release);
  let base;
  let head;
  let range;
  if (eventName === "pull_request") {
    base = event?.pull_request?.base?.sha;
    head = event?.pull_request?.head?.sha;
    // Match the PR's changes, excluding changes made only on its base branch.
    range = "...";
  } else if (eventName === "push") {
    base = event?.before;
    head = sha;
    if (event?.after !== head) return unknownSelection();
    range = "..";
  } else {
    return unknownSelection();
  }
  if (!isCommit(base) || !isCommit(head)) return unknownSelection();
  try {
    const files = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${base}${range}${head}`,
        "--",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\0")
      .filter(Boolean);
    if (files.length === 0) return unknownSelection();
    return {
      scope: isDocsOnly(files) ? "docs" : "full",
      site_deploy: files.some(
        (file) =>
          file.startsWith("apps/site/") ||
          file.startsWith("apps/docs/") ||
          file.startsWith("docs/") ||
          siteInputs.has(file),
      ),
    };
  } catch {
    return unknownSelection();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let selection = unknownSelection(process.env.RELEASE === "true");
  try {
    selection = selectCiScope({
      cwd: process.cwd(),
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      sha: process.env.GITHUB_SHA,
      release: process.env.RELEASE === "true",
      commit: process.env.COMMIT,
    });
  } catch {
    // Unknown inputs cannot opt out of suites or an eligible main deployment.
  }
  console.log(`scope=${selection.scope}`);
  console.log(`site_deploy=${selection.site_deploy}`);
}
