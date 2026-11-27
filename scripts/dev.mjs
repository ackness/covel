import process from "node:process";

import { spawnCommand } from "./lib/command-shim.mjs";
import { SHUTDOWN_SIGNALS, terminateProcessTree } from "./dev-supervisor.mjs";

const commands = [
  {
    name: "server",
    command: "pnpm",
    args: ["--filter", "@covel/server", "dev"],
  },
  {
    name: "web",
    command: "pnpm",
    args: ["--filter", "@covel/web", "dev"],
  },
];

// The dev server runs without Electron's per-URL system proxy resolver. Hand
// it the shell's proxy as the static system proxy so the default `system`
// mode matches the installed app instead of silently going direct.
function devEnvironment(env) {
  if (env.COVEL_SYSTEM_PROXY_URL?.trim()) return env;
  const shellProxy = [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ]
    .map((name) => env[name]?.trim())
    .find(Boolean);
  if (!shellProxy) return env;
  // Never echo proxy credentials into the terminal.
  const shown = shellProxy.replace(/\/\/[^@/]*@/, "//***@");
  console.log(`[dev] using shell proxy as the system proxy: ${shown}`);
  return { ...env, COVEL_SYSTEM_PROXY_URL: shellProxy };
}

const childEnv = devEnvironment(process.env);

let shuttingDown = false;
const children = [];

async function stopAll(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(
    children.map(({ name, child }) =>
      terminateProcessTree(child.pid, {
        gracefulSignal: signal,
        log: (message) => console.log(`[dev:${name}] ${message}`),
      }),
    ),
  );
}

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    void stopAll(signal).finally(() => process.exit(0));
  });
}

// Spawn incrementally into `children` so a mid-startup failure can still
// tear down the siblings that already launched (no orphaned dev servers).
try {
  for (const { name, command, args } of commands) {
    console.log(`[dev] starting ${name}: ${command} ${args.join(" ")}`);
    const child = spawnCommand(command, args, {
      stdio: "inherit",
      env: childEnv,
    });

    if (!child.pid) {
      throw new Error(`Failed to start ${name} dev process`);
    }

    children.push({ name, child });
  }
} catch (error) {
  console.error("[dev] startup failed:", error);
  await stopAll();
  process.exit(1);
}

for (const { name, child } of children) {
  child.once("error", (error) => {
    console.error(`[dev] ${name} failed:`, error);
    void stopAll().finally(() => process.exit(1));
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = typeof code === "number" ? code : 1;
    console.error(
      `[dev] ${name} exited unexpectedly (${code ?? signal ?? "unknown"})`,
    );
    void stopAll().finally(() => process.exit(exitCode));
  });
}
