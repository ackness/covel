import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function quoteWindowsCommandArg(value) {
  const text = String(value);
  if (text.length > 0 && WINDOWS_SAFE_ARG.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '\\"')}"`;
}

export function windowsCommandArgs(command, args = []) {
  return [
    "/d",
    "/s",
    "/c",
    [command, ...args].map(quoteWindowsCommandArg).join(" "),
  ];
}

export function withLocalBinPath(env, cwd = process.cwd()) {
  const nextEnv = { ...env };
  const pathKey =
    Object.keys(nextEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = nextEnv[pathKey] ?? "";
  const localBins = [
    path.resolve(cwd, "node_modules/.bin"),
    path.resolve(process.cwd(), "node_modules/.bin"),
  ];
  const entries = new Set([
    ...localBins,
    ...String(currentPath).split(path.delimiter).filter(Boolean),
  ]);

  nextEnv[pathKey] = [...entries].join(path.delimiter);
  return nextEnv;
}

export function spawnCommand(
  command,
  args = [],
  options = {},
  { spawnImpl = spawn, platform = process.platform, env = process.env } = {},
) {
  if (platform !== "win32") {
    return spawnImpl(command, args, options);
  }

  const spawnEnv = withLocalBinPath(
    options.env ?? env,
    options.cwd ? path.resolve(String(options.cwd)) : process.cwd(),
  );

  return spawnImpl(
    spawnEnv.ComSpec || "cmd.exe",
    windowsCommandArgs(command, args),
    {
      ...options,
      env: spawnEnv,
      windowsVerbatimArguments: true,
    },
  );
}
