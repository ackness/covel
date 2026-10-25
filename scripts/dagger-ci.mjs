import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  pipelineQuery,
  postgresQuery,
  queryLeaf,
  tasksForScope,
} from "./lib/dagger-pipeline.mjs";

const sha = process.env.SOURCE_SHA;
const scope = process.env.CI_SCOPE;
const nonce = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? Date.now()}`;
const tasks = tasksForScope(scope);
const results = [];
const artifactRoot = path.resolve(
  process.env.RUNNER_TEMP ?? "/tmp",
  "covel-dagger-artifacts",
);
mkdirSync(artifactRoot, { recursive: true });

async function runQuery(query) {
  // A shared session keeps the PostgreSQL service ID alive across queries.
  // This token is used only by the trusted host controller, never by task code.
  const port = Number(process.env.DAGGER_SESSION_PORT);
  const token = process.env.DAGGER_SESSION_TOKEN;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535 || !token)
    throw new Error("Run this controller with dagger run");
  const response = await fetch(`http://127.0.0.1:${port}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length)
    throw new Error(
      `Dagger query failed: ${result.errors?.map((error) => error.message).join("; ") ?? response.status}`,
    );
  return queryLeaf(result.data);
}

async function runTask(task) {
  const start = Date.now();
  console.log(`Starting Dagger task: ${task}`);
  try {
    const postgresId =
      task === "postgres"
        ? (await runQuery(postgresQuery(nonce))).id
        : undefined;
    const result = await runQuery(
      pipelineQuery({
        sha,
        scope,
        task,
        nonce,
        postgresId,
        artifactDir: path.join(artifactRoot, "browser"),
      }),
    );
    if (result.exitCode !== 0)
      throw new Error(`Task exited ${result.exitCode}`);
    results.push({ task, success: true, seconds: (Date.now() - start) / 1000 });
  } catch (error) {
    console.error(`Dagger task ${task}: ${error.message}`);
    results.push({
      task,
      success: false,
      seconds: (Date.now() - start) / 1000,
    });
  }
  console.log(JSON.stringify(results.at(-1)));
}

// Bound engine load; all selected tasks still finish and report their results.
const pending = [...tasks];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (pending.length) await runTask(pending.shift());
  }),
);
writeFileSync(
  path.join(artifactRoot, "results.json"),
  JSON.stringify({ sha, scope, results }, null, 2),
);
if (
  results.length !== tasks.length ||
  results.some((result) => !result.success)
)
  process.exitCode = 1;
