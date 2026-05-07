import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { terminateProcessTree } from "./dev-supervisor.mjs";

export const DEV_PORTS = [3001, 5174];

const DEV_COMMAND_PATTERNS = [
  /pnpm(?:\s+run)?\s+dev(?::web|:server|:pg)?(?:\s|$)/,
  /scripts\/dev-supervisor\.mjs\s+turbo\s+dev(?::web|:server|:pg)?(?:\s|$)/,
  /(?:^|\s)turbo\s+dev(?::web|:server|:pg)?(?:\s|$)/,
  /tsx\/dist\/cli\.mjs\s+watch(?:\s|$)/,
  /vite\/bin\/vite\.js(?:\s|$)/,
];

const EXCLUDED_COMMAND_PATTERNS = [
  /(?:^|\s)pnpm(?:\s+run)?\s+test:watch(?:\s|$)/,
  /vite\/bin\/vite\.js\s+preview(?:\s|$)/,
];

export const parseProcessTable = (stdout) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);

      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter(
      (processInfo) =>
        processInfo &&
        Number.isInteger(processInfo.pid) &&
        Number.isInteger(processInfo.ppid),
    );

export const parsePidList = (stdout) =>
  new Set(
    stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );

export const matchesDevCommand = (command) => {
  if (!command) {
    return false;
  }

  if (EXCLUDED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }

  return DEV_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
};

const runAndCollect = async (
  command,
  args,
  { allowEmpty = false, spawnImpl = spawn } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      if (allowEmpty && code === 1 && !stderr.trim()) {
        resolve("");
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
        ),
      );
    });
  });

const runPowerShellAndCollect = async (
  script,
  { allowEmpty = false, spawnImpl = spawn } = {},
) =>
  runAndCollect(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { allowEmpty, spawnImpl },
  );

const parseWindowsProcessJson = (stdout) => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const records = JSON.parse(trimmed);
  const list = Array.isArray(records) ? records : [records];

  return list
    .map((record) => ({
      pid: Number(record.ProcessId),
      ppid: Number(record.ParentProcessId),
      command: String(record.CommandLine ?? ""),
    }))
    .filter(({ pid, ppid }) => Number.isInteger(pid) && Number.isInteger(ppid));
};

export const listProcesses = async ({ spawnImpl = spawn } = {}) =>
  process.platform === "win32"
    ? parseWindowsProcessJson(
        await runPowerShellAndCollect(
          "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress",
          { spawnImpl },
        ),
      )
    : parseProcessTable(
        await runAndCollect("ps", ["-Ao", "pid=,ppid=,command="], {
          spawnImpl,
        }),
      );

export const listRepoPids = async (repoDir, { spawnImpl = spawn } = {}) =>
  process.platform === "win32"
    ? new Set(
        (await listProcesses({ spawnImpl }))
          .filter(({ command }) => command.includes(repoDir))
          .map(({ pid }) => pid),
      )
    : parsePidList(
        await runAndCollect("lsof", ["-t", "+D", repoDir], {
          allowEmpty: true,
          spawnImpl,
        }),
      );

export const listListeningPids = async (
  ports = DEV_PORTS,
  { spawnImpl = spawn } = {},
) =>
  process.platform === "win32"
    ? parsePidList(
        await runPowerShellAndCollect(
          `$ports = @(${ports.join(", ")}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $_ }`,
          { allowEmpty: true, spawnImpl },
        ),
      )
    : parsePidList(
        await runAndCollect(
          "lsof",
          [
            "-nP",
            "-t",
            "-sTCP:LISTEN",
            ...ports.map((port) => `-iTCP:${port}`),
          ],
          { allowEmpty: true, spawnImpl },
        ),
      );

export const collectCandidatePids = (
  processes,
  repoPids,
  listeningPids = new Set(),
  repoDir = "",
) => {
  const processesByPid = new Map(
    processes.map((processInfo) => [processInfo.pid, processInfo]),
  );
  const candidates = new Set();

  for (const processInfo of processes) {
    const repoRelated =
      repoPids.has(processInfo.pid) ||
      (repoDir !== "" && processInfo.command.includes(repoDir));
    const listening = listeningPids.has(processInfo.pid);

    if (
      (repoRelated && matchesDevCommand(processInfo.command)) ||
      (repoRelated && listening)
    ) {
      candidates.add(processInfo.pid);
    }
  }

  for (const pid of [...candidates]) {
    let current = processesByPid.get(pid);

    while (current) {
      const parent = processesByPid.get(current.ppid);

      if (!parent || !matchesDevCommand(parent.command)) {
        break;
      }

      candidates.add(parent.pid);
      current = parent;
    }
  }

  return candidates;
};

export const selectRootPids = (processes, candidates) =>
  processes
    .filter(({ pid, ppid }) => candidates.has(pid) && !candidates.has(ppid))
    .map(({ pid }) => pid);

export const stopDevProcesses = async (
  repoDir,
  {
    listProcessesImpl = listProcesses,
    listRepoPidsImpl = listRepoPids,
    listListeningPidsImpl = listListeningPids,
    terminateProcessTreeImpl = terminateProcessTree,
    log = () => {},
  } = {},
) => {
  const processes = await listProcessesImpl();
  const repoPids = await listRepoPidsImpl(repoDir);
  const listeningPids = await listListeningPidsImpl();
  const candidates = collectCandidatePids(
    processes,
    repoPids,
    listeningPids,
    repoDir,
  );
  const rootPids = selectRootPids(processes, candidates);

  for (const pid of rootPids) {
    log(`Stopping dev process tree rooted at ${pid}...`);
    await terminateProcessTreeImpl(pid, { log });
  }

  const remainingProcesses = await listProcessesImpl();
  const remainingRepoPids = await listRepoPidsImpl(repoDir);
  const remainingListeningPids = await listListeningPidsImpl();
  const remainingCandidates = collectCandidatePids(
    remainingProcesses,
    remainingRepoPids,
    remainingListeningPids,
    repoDir,
  );
  const remainingRootPids = selectRootPids(
    remainingProcesses,
    remainingCandidates,
  );

  return {
    rootPids,
    remainingRootPids,
  };
};

export const main = async (cwd = process.cwd()) => {
  const { rootPids, remainingRootPids } = await stopDevProcesses(cwd, {
    log: (message) => {
      console.log(message);
    },
  });

  if (rootPids.length === 0) {
    console.log("No frontend/backend dev processes found.");
    return 0;
  }

  if (remainingRootPids.length > 0) {
    console.error(
      `Failed to stop dev process roots: ${remainingRootPids.join(", ")}`,
    );
    return 1;
  }

  console.log(
    `Stopped ${rootPids.length} frontend/backend dev process root(s).`,
  );
  return 0;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await main();
  process.exit(exitCode);
}
