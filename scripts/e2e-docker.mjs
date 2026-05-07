import { spawn } from "node:child_process";
import process from "node:process";

const repoRoot = process.cwd();
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const composeArgs = ["compose", "-f", "docker/docker-compose.e2e.yml"];
const healthUrl = "http://localhost:3001/api/health";

function run(command, args, { env = process.env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolve(code ?? 0);
        return;
      }

      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`),
      );
    });
  });
}

async function waitForHealth(timeoutMs = 120_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the service comes up or the timeout expires.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${healthUrl}`);
}

async function up() {
  await run(dockerCommand, [...composeArgs, "up", "--build", "-d"]);
  console.log("Waiting for app...");
  await waitForHealth();
  console.log("App ready!");
}

async function down() {
  await run(dockerCommand, [...composeArgs, "down", "-v"], {
    allowFailure: true,
  });
}

async function runSuite() {
  await up();

  try {
    await run(pnpmCommand, ["e2e"], {
      env: {
        ...process.env,
        E2E_BASE_URL: "http://localhost:3001",
      },
    });
  } finally {
    await down();
  }
}

const command = process.argv[2];

switch (command) {
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "run":
    await runSuite();
    break;
  default:
    console.error("Usage: node scripts/e2e-docker.mjs <up|down|run>");
    process.exit(1);
}
