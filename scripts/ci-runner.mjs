import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eligibleOwnerPr } from "./lib/dagger-pr-policy.mjs";

export function selectCiRunner({ eventName, event, release, commit, cwd }) {
  if (
    eventName !== "pull_request" ||
    release ||
    commit ||
    !eligibleOwnerPr(event?.pull_request)
  )
    return "github";
  try {
    // Roll out only after the trusted executor exists on the PR's base.
    // The PR introducing this feature still gets all ordinary GitHub checks.
    execFileSync(
      "git",
      [
        "cat-file",
        "-e",
        `${event.pull_request.base.sha}:.github/workflows/dagger-pr.yml`,
      ],
      { cwd, stdio: "ignore" },
    );
    return "dagger";
  } catch {
    return "github";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let runner = "github";
  try {
    runner = selectCiRunner({
      cwd: process.cwd(),
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      release: process.env.RELEASE === "true",
      commit: process.env.COMMIT,
    });
  } catch {
    // Failure to establish the trust boundary retains ordinary CI.
  }
  console.log(`runner=${runner}`);
}
