#!/usr/bin/env node
// Check or shrink the frozen export list of the `@covel/shared` root entry.
//   node scripts/shared-barrel-baseline.mjs            verify
//   node scripts/shared-barrel-baseline.mjs --update   record removed exports
// `--update` refuses to record a new export: the baseline may only shrink.
// `--root <dir>` targets another checkout (used by the script tests).
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentBarrel,
  sharedBarrel,
  sharedBarrelErrors,
  writeBaseline,
} from "./lib/barrel-exports.mjs";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1
    ? fileURLToPath(new URL("..", import.meta.url))
    : path.resolve(process.argv[rootFlag + 1] ?? ".");
const current = currentBarrel(root);
const update = process.argv.includes("--update");
const errors = sharedBarrelErrors(root, current);
if (update) {
  const added = errors.filter((error) => error.startsWith(sharedBarrel.entry));
  if (added.length) {
    console.error(added.join("\n"));
    process.exitCode = 1;
  } else {
    writeBaseline(root, current);
    console.log(`Recorded ${current.length} root exports.`);
  }
} else if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Shared root entry frozen at ${current.length} exports.`);
