import path from "node:path";
import process from "node:process";
import { spawnCommand } from "./lib/command-shim.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error(
    "Usage: node scripts/run-with-project-node.mjs <command> [args...]",
  );
  process.exit(1);
}

// Propagate the Node selected by mise to CLI shims and their descendants.
const env = { ...process.env };
const pathKey =
  Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
env[pathKey] =
  `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ""}`;
const child = spawnCommand(command, args, { stdio: "inherit", env });
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) console.error(`Command exited with signal ${signal}`);
  process.exit(code ?? 1);
});
