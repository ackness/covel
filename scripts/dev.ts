import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DEFAULT_RUNTIME_HOST = "127.0.0.1";
const DEFAULT_RUNTIME_PORT = "8787";
const DEFAULT_WEB_PORT = "5173";
const MAX_RUNTIME_PORT_ATTEMPTS = 20;

export interface DevEnvironmentConfig {
  runtimeHost: string;
  runtimePort: string;
  webPort: string;
}

export interface DevCommandSpec {
  name: "runtime" | "web";
  args: string[];
  env: Record<string, string>;
}

export type IsPortAvailable = (host: string, port: number) => Promise<boolean>;

export function resolveDevEnvironmentConfig(env: Record<string, string | undefined> = process.env): DevEnvironmentConfig {
  return {
    runtimeHost: env.RUNTIME_HOST?.trim() || DEFAULT_RUNTIME_HOST,
    runtimePort: normalizePort(env.RUNTIME_PORT, DEFAULT_RUNTIME_PORT),
    webPort: normalizePort(env.WEB_PORT, DEFAULT_WEB_PORT)
  };
}

export function createDevCommandSpecs(env: Record<string, string | undefined> = process.env): DevCommandSpec[] {
  return createDevCommandSpecsFromConfig(resolveDevEnvironmentConfig(env), env);
}

export function createDevCommandSpecsFromConfig(
  config: DevEnvironmentConfig,
  env: Record<string, string | undefined> = process.env
): DevCommandSpec[] {
  const sharedEnv = createChildEnv(env);

  return [
    {
      name: "runtime",
      args: ["start:runtime"],
      env: {
        ...sharedEnv,
        HOST: config.runtimeHost,
        PORT: config.runtimePort
      }
    },
    {
      name: "web",
      args: ["exec", "vite", "--config", "apps/web/vite.config.ts", "--port", config.webPort],
      env: {
        ...sharedEnv,
        RUNTIME_HOST: config.runtimeHost,
        RUNTIME_PORT: config.runtimePort
      }
    }
  ];
}

export async function resolveAvailableDevEnvironmentConfig(
  env: Record<string, string | undefined> = process.env,
  isPortAvailable: IsPortAvailable = checkPortAvailability
): Promise<DevEnvironmentConfig> {
  const config = resolveDevEnvironmentConfig(env);
  const runtimePort = Number.parseInt(config.runtimePort, 10);

  if (env.RUNTIME_PORT?.trim()) {
    if (!(await isPortAvailable(config.runtimeHost, runtimePort))) {
      throw new Error(
        `RUNTIME_PORT ${config.runtimePort} is already in use on ${config.runtimeHost}. ` +
        "Set RUNTIME_PORT to a different port or stop the existing runtime."
      );
    }

    return config;
  }

  return {
    ...config,
    runtimePort: await findAvailablePort(config.runtimeHost, runtimePort, isPortAvailable)
  };
}

export async function runDevEnvironment(env: Record<string, string | undefined> = process.env) {
  const requestedConfig = resolveDevEnvironmentConfig(env);
  const resolvedConfig = await resolveAvailableDevEnvironmentConfig(env);

  if (requestedConfig.runtimePort !== resolvedConfig.runtimePort) {
    console.log(
      `[dev] runtime port ${requestedConfig.runtimePort} is busy, using ${resolvedConfig.runtimePort}`
    );
  }

  const commands = createDevCommandSpecsFromConfig(resolvedConfig, env);
  const children = commands.map((command) => spawnManagedProcess(command));
  let isShuttingDown = false;

  const stopAll = (exitCode = 0) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    process.exitCode = exitCode;

    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }

    setTimeout(() => {
      for (const child of children) {
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    }, 5_000).unref();
  };

  for (const [index, child] of children.entries()) {
    const command = commands[index];

    child.on("exit", (code, signal) => {
      if (isShuttingDown) {
        return;
      }

      if (signal) {
        console.error(`[${command.name}] exited with signal ${signal}`);
        stopAll(1);
        return;
      }

      if (typeof code === "number" && code !== 0) {
        console.error(`[${command.name}] exited with code ${code}`);
        stopAll(code);
        return;
      }

      console.error(`[${command.name}] exited`);
      stopAll(0);
    });

    child.on("error", (error) => {
      if (isShuttingDown) {
        return;
      }

      console.error(`[${command.name}] failed to start: ${error.message}`);
      stopAll(1);
    });
  }

  const handleSignal = (signal: NodeJS.Signals) => {
    console.log(`[dev] received ${signal}, shutting down`);
    stopAll(0);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

async function findAvailablePort(
  host: string,
  startingPort: number,
  isPortAvailable: IsPortAvailable
): Promise<string> {
  for (let offset = 0; offset < MAX_RUNTIME_PORT_ATTEMPTS; offset += 1) {
    const candidate = startingPort + offset;
    if (await isPortAvailable(host, candidate)) {
      return String(candidate);
    }
  }

  throw new Error(
    `No available runtime port found from ${startingPort} to ${startingPort + MAX_RUNTIME_PORT_ATTEMPTS - 1}.`
  );
}

function normalizePort(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : fallback;
}

function createChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function checkPortAvailability(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();

      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.once("listening", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

function spawnManagedProcess(command: DevCommandSpec): ChildProcessWithoutNullStreams {
  const child = spawn(PNPM_COMMAND, command.args, {
    env: command.env,
    stdio: ["inherit", "pipe", "pipe"]
  });

  forwardLines(child.stdout, command.name, "log");
  forwardLines(child.stderr, command.name, "error");

  return child;
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  label: DevCommandSpec["name"],
  level: "log" | "error"
) {
  const output = readline.createInterface({ input: stream });
  output.on("line", (line) => {
    console[level](`[${label}] ${line}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevEnvironment().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev] ${message}`);
    process.exitCode = 1;
  });
}
