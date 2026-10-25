import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkIdentity,
  checkName,
  eligibleOwnerPr,
  isSha,
  remoteCheckState,
  repository,
} from "./lib/dagger-pr-policy.mjs";
import { isDocsOnly } from "./lib/change-scope.mjs";

function api(path, body, paginate = false) {
  const args = ["api", `repos/${repository}/${path}`];
  if (paginate) args.push("--paginate", "--slurp");
  if (body) args.push("--method", body.method ?? "POST", "--input", "-");
  const { method: _method, ...data } = body ?? {};
  const output = execFileSync("gh", args, {
    input: body ? JSON.stringify(data) : undefined,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : null;
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const prNumber = event.pull_request?.number;

if (process.argv[2] === "prepare") {
  if (!eligibleOwnerPr(event.pull_request))
    throw new Error("Only the owner's same-repository PRs are authorized");
  let pr;
  for (let attempt = 0; attempt < 15; attempt++) {
    pr = api(`pulls/${prNumber}`);
    if (
      !eligibleOwnerPr(pr) ||
      pr.head.sha !== event.pull_request.head.sha ||
      pr.base.sha !== event.pull_request.base.sha
    )
      throw new Error("PR identity or revision changed; refusing stale work");
    if (pr.mergeable === false) throw new Error("PR has merge conflicts");
    if (pr.mergeable && isSha(pr.merge_commit_sha)) break;
    await delay(2000);
  }
  if (!pr.mergeable || !isSha(pr.merge_commit_sha))
    throw new Error("GitHub has not prepared a test merge commit");
  const commit = api(`git/commits/${pr.merge_commit_sha}`);
  if (
    commit.parents?.length !== 2 ||
    commit.parents[0].sha !== pr.base.sha ||
    commit.parents[1].sha !== pr.head.sha
  )
    throw new Error("Test merge does not match the authorized base and head");
  const files = api(`pulls/${prNumber}/files?per_page=100`, null, true).flat();
  const paths = files.flatMap((file) =>
    file.previous_filename
      ? [file.filename, file.previous_filename]
      : [file.filename],
  );
  const scope =
    files.length > 0 && files.length === pr.changed_files && isDocsOnly(paths)
      ? "docs"
      : "full";
  const check = api("check-runs", {
    name: checkName,
    head_sha: pr.head.sha,
    external_id: checkIdentity(prNumber, pr.merge_commit_sha),
    status: "in_progress",
    details_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    output: {
      title: "Remote Linux verification",
      summary: `Testing merge ${pr.merge_commit_sha}; scope=${scope}.`,
    },
  });
  for (const [key, value] of Object.entries({
    check_id: check.id,
    merge_sha: pr.merge_commit_sha,
    scope,
  }))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
} else if (process.argv[2] === "complete") {
  const checkId = Number(process.env.CHECK_ID);
  if (!Number.isSafeInteger(checkId) || checkId <= 0)
    throw new Error("Missing check ID");
  const conclusion =
    process.env.RUN_OUTCOME === "success"
      ? "success"
      : process.env.RUN_OUTCOME === "cancelled"
        ? "cancelled"
        : "failure";
  api(`check-runs/${checkId}`, {
    method: "PATCH",
    status: "completed",
    conclusion,
    output: {
      title: `Remote Linux verification: ${conclusion}`,
      summary:
        "See the trusted Dagger workflow for individual task logs and failure artifacts.",
    },
  });
} else if (process.argv[2] === "wait") {
  if (!eligibleOwnerPr(event.pull_request) || !isSha(process.env.GITHUB_SHA))
    throw new Error("Unexpected PR context for Dagger verification");
  const expected = checkIdentity(prNumber, process.env.GITHUB_SHA);
  for (let attempt = 0; attempt < 100; attempt++) {
    const pages = api(
      `commits/${event.pull_request.head.sha}/check-runs?per_page=100&filter=all`,
      null,
      true,
    );
    const state = remoteCheckState(
      pages.flatMap((page) => page.check_runs),
      expected,
    );
    if (state === "success") {
      console.log(`Dagger verified ${process.env.GITHUB_SHA}`);
      break;
    }
    if (state === "failure")
      throw new Error("Remote Dagger verification failed");
    if (attempt === 99)
      throw new Error("Timed out waiting for Dagger verification");
    console.log(
      "Waiting for trusted Dagger result for this exact merge commit",
    );
    await delay(20000);
  }
} else {
  throw new Error("Expected prepare, complete, or wait");
}
