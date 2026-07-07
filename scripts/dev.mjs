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

let shuttingDown = false;

const children = commands.map(({ name, command, args }) => {
  console.log(`[dev] starting ${name}: ${command} ${args.join(" ")}`);
  const child = spawnCommand(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (!child.pid) {
    throw new Error(`Failed to start ${name} dev process`);
  }

  return { name, child };
});

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
