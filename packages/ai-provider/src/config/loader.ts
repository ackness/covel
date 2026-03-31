import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { aiConfigSchema } from "./schema.js";
import type { AiConfig } from "../types.js";

/**
 * Load and validate an AI config from a TOML file.
 * Interpolates `${VAR_NAME}` patterns from process.env.
 */
export function loadAiConfig(filePath: string): AiConfig {
  const absolutePath = resolve(filePath);
  const raw = readFileSync(absolutePath, "utf-8");
  const interpolated = interpolateEnv(raw);
  const parsed = parseToml(interpolated);
  const validated = aiConfigSchema.parse(parsed);
  return validated;
}

/**
 * Parse an AI config from a raw TOML string.
 * Interpolates `${VAR_NAME}` patterns from process.env.
 */
export function parseAiConfig(toml: string): AiConfig {
  const interpolated = interpolateEnv(toml);
  const parsed = parseToml(interpolated);
  const validated = aiConfigSchema.parse(parsed);
  return validated;
}

/**
 * Replace `${VAR_NAME}` with values from process.env.
 * Throws if any referenced variable is not set.
 */
function interpolateEnv(input: string): string {
  const missing: string[] = [];

  const result = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)}/g, (match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      missing.push(varName);
      return match;
    }
    return value;
  });

  if (missing.length > 0) {
    throw new Error(
      `AI config: unresolved environment variables: ${missing.join(", ")}`
    );
  }

  return result;
}
