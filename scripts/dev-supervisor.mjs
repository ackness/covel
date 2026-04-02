import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { constants as osConstants } from "node:os";

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export const collectDescendantPids = (rootPid, processes) => {
  const childrenByParent = new Map();

  for (const { pid, ppid } of processes) {
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }

  const descendants = [];
  const visit = (pid) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };

  visit(rootPid);

  return descendants;
};

export const parseProcessList = (stdout) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidText, ppidText] = line.split(/\s+/);
      return {
        pid: Number(pidText),
        ppid: Number(ppidText),
      };
    })
    .filter(({ pid, ppid }) => Number.isInteger(pid) && Number.isInteger(ppid));

export const listProcesses = async () =>
  new Promise((resolve, reject) => {
    const ps = spawn("ps", ["-Ao", "pid=,ppid="], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    ps.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    ps.once("error", reject);
    ps.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`ps exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      resolve(parseProcessList(stdout));
    });
  });

export const signalProcess = async (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return;
    }

    throw error;
  }
};

export const isProcessAlive = async (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
};

export const delay = (timeoutMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

export const terminateProcessTree = async (
  rootPid,
  {
    listProcesses: listProcessesImpl = listProcesses,
    signalProcess: signalProcessImpl = signalProcess,
    isProcessAlive: isProcessAliveImpl = isProcessAlive,
    delay: delayImpl = delay,
    gracefulSignal = "SIGTERM",
    gracefulWaitMs = 3_000,
    forceWaitMs = 1_000,
    pollIntervalMs = 100,
    log = () => {},
  } = {},
) => {
  if (!rootPid) {
    return true;
  }

  const signalTree = async (signal) => {
    const processes = await listProcessesImpl();
    const pids = [...collectDescendantPids(rootPid, processes), rootPid];

    for (const pid of pids) {
      await signalProcessImpl(pid, signal);
    }
  };

  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!(await isProcessAliveImpl(rootPid))) {
        return true;
      }

      await delayImpl(Math.min(pollIntervalMs, deadline - Date.now()));
    }

    return !(await isProcessAliveImpl(rootPid));
  };

  await signalTree(gracefulSignal);

  if (await waitForExit(gracefulWaitMs)) {
    return true;
  }

  log(`Process ${rootPid} did not exit after ${gracefulWaitMs}ms; forcing shutdown.`);

  await signalTree("SIGKILL");

  return waitForExit(forceWaitMs);
};

export const runCommandWithSupervisor = async (
  command,
  args,
  {
    spawnImpl = spawn,
    terminateProcessTreeImpl = terminateProcessTree,
    log = console.log,
    processObject = process,
  } = {},
) => {
  const child = spawnImpl(command, args, {
    stdio: "inherit",
    env: processObject.env,
  });

  if (!child.pid) {
    throw new Error(`Failed to start command: ${command}`);
  }

  let shutdownPromise;

  const removeListeners = [];

  const startShutdown = (signal) => {
    if (shutdownPromise) {
      return;
    }

    log(`Received ${signal}, stopping dev process tree...`);
    shutdownPromise = terminateProcessTreeImpl(child.pid, {
      gracefulSignal: signal,
      log,
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = () => {
      startShutdown(signal);
    };

    processObject.on(signal, listener);
    removeListeners.push(() => {
      processObject.off(signal, listener);
    });
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  for (const removeListener of removeListeners) {
    removeListener();
  }

  const cleaned = shutdownPromise ? await shutdownPromise : true;

  if (!cleaned) {
    return 1;
  }

  if (shutdownPromise) {
    return 0;
  }

  if (typeof result.code === "number") {
    return result.code;
  }

  if (result.signal) {
    return 128 + (osConstants.signals[result.signal] ?? 1);
  }

  return 1;
};

export const main = async (argv = process.argv.slice(2)) => {
  const [command, ...args] = argv;

  if (!command) {
    console.error("Usage: node scripts/dev-supervisor.mjs <command> [...args]");
    return 1;
  }

  return runCommandWithSupervisor(command, args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
