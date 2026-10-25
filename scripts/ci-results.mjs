import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fullJobs = ["tests", "web", "server", "postgres", "browser"];

/** Validate native jobs.needs results, including jobs GitHub skipped. */
export function verificationFailures(needs, release = false) {
  const failures = [];
  if (needs?.scope?.result !== "success")
    failures.push("scope did not succeed");
  const scope = needs?.scope?.outputs?.scope;
  if (scope !== "docs" && scope !== "full")
    failures.push("scope is missing or unknown");
  const runner = needs?.scope?.outputs?.runner ?? "github";
  if (!["github", "dagger"].includes(runner))
    failures.push("unknown execution backend");
  if (runner === "dagger") {
    if (release) failures.push("releases cannot delegate to the PR executor");
    if (needs?.dagger?.result !== "success")
      failures.push("dagger did not succeed");
    for (const job of ["verify", "site", ...fullJobs]) {
      if (needs?.[job]?.result !== "skipped")
        failures.push(`${job} must be skipped when Dagger owns verification`);
    }
    return failures;
  }
  if (needs?.dagger && needs.dagger.result !== "skipped")
    failures.push("unexpected Dagger result on GitHub execution path");
  const required = [
    "verify",
    ...(release ? [] : ["site"]),
    ...(scope === "docs" && !release ? [] : fullJobs),
  ];
  for (const job of required) {
    if (needs?.[job]?.result !== "success")
      failures.push(`${job} did not succeed`);
  }
  // Even unneeded jobs must not hide a failure or cancellation.
  for (const job of [...fullJobs, "site"]) {
    if (
      !required.includes(job) &&
      !["success", "skipped"].includes(needs?.[job]?.result)
    )
      failures.push(`${job} has an unexpected result`);
  }
  return failures;
}

/** Decide one poll of GitHub's paginated check-runs response. */
export function checkRunsState(pages) {
  if (
    !Array.isArray(pages) ||
    pages.some((page) => !Array.isArray(page?.check_runs))
  )
    throw new Error("Invalid check-runs response");
  const runs = pages
    .flatMap((page) => page.check_runs)
    .filter((run) => run.name !== "All checks pass");
  const required = runs.filter(
    (run) => run.name === "Verification" && run.app?.slug === "github-actions",
  );
  for (const run of runs) {
    if (run.status === "completed") {
      const accepted = required.includes(run)
        ? ["success"]
        : ["success", "skipped", "neutral"];
      if (!accepted.includes(run.conclusion)) return "failure";
    } else if (
      !["queued", "in_progress", "waiting", "pending", "requested"].includes(
        run.status,
      )
    ) {
      return "failure";
    }
  }
  if (required.length === 0 || runs.some((run) => run.status !== "completed"))
    return "pending";
  return "success";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "verification") {
      const failures = verificationFailures(
        JSON.parse(process.env.NEEDS),
        process.env.RELEASE === "true",
      );
      if (failures.length > 0) throw new Error(failures.join("\n"));
      console.log("Every selected verification job succeeded.");
    } else if (process.argv[2] === "checks") {
      console.log(checkRunsState(JSON.parse(readFileSync(0, "utf8"))));
    } else {
      throw new Error("Expected verification or checks");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
