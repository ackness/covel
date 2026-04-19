import { spawn } from "node:child_process";
import process from "node:process";

const argv = process.argv.slice(2);
const envOverrides = {};
let commandIndex = 0;

for (; commandIndex < argv.length; commandIndex += 1) {
  const token = argv[commandIndex];
  if (!token.includes("=") || token.startsWith("-")) {
    break;
  }

  const separator = token.indexOf("=");
  const key = token.slice(0, separator);
  const value = token.slice(separator + 1);
  envOverrides[key] = value;
}

const [command, ...args] = argv.slice(commandIndex);

if (!command) {
  console.error(
    "Usage: node scripts/run-with-env.mjs KEY=value [MORE=value ...] <command> [args...]",
  );
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...envOverrides,
  },
});

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }

  if (signal) {
    console.error(`Command exited with signal ${signal}`);
  }
  process.exit(1);
});
