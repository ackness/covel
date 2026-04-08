import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ReferenceService, ReferenceLoadInput, ReferenceLoadResult } from "./types.js";

/**
 * Reference loading service — reads files from a runtime's references/ directory.
 */
export function createReferenceService(): ReferenceService {
  async function load(input: ReferenceLoadInput): Promise<ReferenceLoadResult> {
    const resolved = resolve(input.referencesDir, input.file);
    const normalizedDir = resolve(input.referencesDir);

    // Path security: prevent directory traversal
    if (!resolved.startsWith(normalizedDir + "/") && resolved !== normalizedDir) {
      throw new Error(`Reference path "${input.file}" escapes references directory.`);
    }

    const content = await readFile(resolved, "utf-8");
    const info = await stat(resolved);

    return {
      content,
      sizeBytes: info.size,
    };
  }

  return { load };
}
