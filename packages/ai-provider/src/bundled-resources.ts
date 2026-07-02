import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Package root = two levels up from this file (src/bundled-resources.ts → src → pkg root).
// Works both in dev (source consumption via workspace) and in `pnpm deploy` output,
// where this file lives under `node_modules/@covel/ai-provider/src/`.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const BUNDLED_MODEL_DB_PATH = resolve(
  PACKAGE_ROOT,
  "data/model-db.json",
);
