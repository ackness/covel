/**
 * Output schema gate for function runtimes.
 *
 * A function handler returns `{ outcome, value, ... }`; a successful `value`
 * is validated against the runtime's `output.schema`. A mismatch fails the
 * runtime and commits no domain effects.
 *
 * Pinned behaviours (via `executeTurn` → `executeFunctionRuntime`):
 *   1. value conforms → success.
 *   2. value violates schema → failed with output-schema-invalid.
 *   3. no output.schema declared → validation is skipped.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

const VALUE_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: { prompt: { type: "string" } },
} as const;

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "fn-plugin/observer",
    pluginId: "fn-plugin",
    pluginType: "community",
    stage: "narrative",
    trigger: { type: "auto" },
    model: "gpt-4o-mini",
    runtimeType: "function",
    ...overrides,
  } as RuntimeManifest;
}

function input(sessionId: string): TurnInput {
  return { sessionId, turnId: `${sessionId}-turn`, playerMessage: "hi" };
}

function makeDeps(loaded: LoadedRuntime): TurnExecutorDeps {
  return {
    loadRuntime: async () => loaded,
    store: createMemoryStore(),
  } as TurnExecutorDeps;
}

describe("function output schema gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts a value that conforms to the schema", async () => {
    const returned = { outcome: "success", value: { prompt: "ok" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({ output: { schema: "./output.schema.json" } }),
      promptTemplate: "",
      outputSchema: { ...VALUE_SCHEMA },
      handler: async () => returned,
    };

    const result = await executeTurn(
      input("sess-fn-ok"),
      [loaded.manifest],
      makeDeps(loaded),
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.runtimeResults[0]?.status).toBe("success");
    // Function values are materialized for kernel consumers.
    expect(result.runtimeResults[0]?.output).toEqual({ prompt: "ok" });
  });

  it("fails with output-schema-invalid when the value violates the schema", async () => {
    const returned = { outcome: "success", value: { wrong: "shape" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({ output: { schema: "./output.schema.json" } }),
      promptTemplate: "",
      outputSchema: { ...VALUE_SCHEMA },
      handler: async () => returned,
    };

    const result = await executeTurn(
      input("sess-fn-bad"),
      [loaded.manifest],
      makeDeps(loaded),
    );

    const runtimeResult = result.runtimeResults[0];
    expect(runtimeResult?.status).toBe("failed");
    expect(runtimeResult?.error).toContain("output-schema-invalid");
  });

  it("skips validation when no output.schema was loaded", async () => {
    const returned = { outcome: "success", value: { wrong: "shape" } };
    const loaded: LoadedRuntime = {
      manifest: manifest(),
      promptTemplate: "",
      // No outputSchema loaded → nothing to validate against.
      handler: async () => returned,
    };

    const result = await executeTurn(
      input("sess-fn-noschema"),
      [loaded.manifest],
      makeDeps(loaded),
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.runtimeResults[0]?.status).toBe("success");
  });
});
