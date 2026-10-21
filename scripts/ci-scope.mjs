import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDocsOnly } from "./lib/change-scope.mjs";

const isCommit = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{40,64}$/.test(value) &&
  !/^0+$/.test(value);

/** Only a successful, nonempty diff can opt out of the full suites. */
export function selectCiScope({ cwd, eventName, event, sha, release, commit }) {
  if (release || commit) return "full";
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
    if (event?.after !== head) return "full";
    range = "..";
  } else {
    return "full";
  }
  if (!isCommit(base) || !isCommit(head)) return "full";
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
    return isDocsOnly(files) ? "docs" : "full";
  } catch {
    return "full";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let scope = "full";
  try {
    scope = selectCiScope({
      cwd: process.cwd(),
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      sha: process.env.GITHUB_SHA,
      release: process.env.RELEASE === "true",
      commit: process.env.COMMIT,
    });
  } catch {
    // Missing or malformed event data is not evidence of documentation-only work.
  }
  console.log(`scope=${scope}`);
}
