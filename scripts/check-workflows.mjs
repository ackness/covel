import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

export function checkWorkflows(
  repoRoot = defaultRoot,
  actionlint = "actionlint",
) {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const workflows = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => path.join(workflowDir, name));
  if (workflows.length === 0)
    throw new Error("No GitHub Actions workflow YAML files found.");

  const result = spawnSync(actionlint, workflows, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "actionlint is required for workflow validation but is not installed.",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `actionlint failed (${result.status}):\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    checkWorkflows();
    console.log("GitHub Actions workflows passed actionlint.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
