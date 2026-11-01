import { isBuiltin } from "node:module";
import { runtimeRequires } from "../../../scripts/lib/runtime-requires.mjs";

/** Main ships as one file, with only Electron and Node builtins supplied at runtime. */
export function assertMainBundle(source, filename) {
  for (const specifier of runtimeRequires(filename, source)) {
    if (specifier !== "electron" && !isBuiltin(specifier)) {
      throw new Error(
        `Desktop main bundle ${filename} has an unbundled runtime require: ${specifier}`,
      );
    }
  }
}
