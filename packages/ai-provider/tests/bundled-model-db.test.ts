import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_MODEL_DB_PATH } from "../src/bundled-resources.js";
import type { ModelDbFile } from "../src/capability/model-db.js";

describe("bundled model database", () => {
  it("ships a deterministic LiteLLM revision with internally consistent data", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../model-db-source.json",
        ),
        "utf-8",
      ),
    ) as { revision: string; updatedAt: string };
    const database = JSON.parse(
      readFileSync(BUNDLED_MODEL_DB_PATH, "utf-8"),
    ) as ModelDbFile;

    expect(database.source).toBe(
      `https://raw.githubusercontent.com/BerriAI/litellm/${manifest.revision}/model_prices_and_context_window.json`,
    );
    expect(database.updatedAt).toBe(manifest.updatedAt);
    expect(database.count).toBe(Object.keys(database.models).length);
    expect(database.count).toBeGreaterThan(1_000);
    expect(database.models["gpt-4o"]).toBeDefined();
  });
});
