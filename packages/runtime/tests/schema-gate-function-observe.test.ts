/**
 * envelope-v1 schema gate for function runtimes.
 *
 * Function runtimes historically had no output validation. The scheduling
 * redesign introduces `resultFormat: "envelope-v1"`, where the handler returns
 * a `{ outcome, value, ... }` envelope and `value` is validated against the
 * runtime's `output.schema`.
 *
 * Step 3 change (docs 02 §4.3): envelope-v1 now ENFORCES — a mismatch fails the
 * runtime with `output-schema-invalid` and commits no domain effects. Legacy
 * stays observe-only (a warn, result unchanged) for one more compat cycle.
 *
 * Pinned behaviours (via `executeTurn` → `executeFunctionRuntime`):
 *   1. envelope-v1 + value conforms → no warn, success, result unchanged.
 *   2. envelope-v1 + value violates schema → FAILED with output-schema-invalid,
 *      no warn (deliberate change from Step 0's observe-only warn).
 *   3. legacy + violating return → observe-only warn on the WHOLE object
 *      (docs 02 §4.3), result unchanged.
 *   4. envelope-v1 + no output.schema declared → skipped, no warn, success.
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
    priority: 500,
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

describe("function envelope-v1 schema observe (Step 0)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("does not warn when the envelope-v1 value conforms to the schema", async () => {
    const returned = { outcome: "success", value: { prompt: "ok" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({
        resultFormat: "envelope-v1",
        output: { schema: "./output.schema.json" },
      }),
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
    // Deliberate change: a success envelope is now projected to the legacy
    // top-level output (value flattened) so the kernel consumers read it.
    expect(result.runtimeResults[0]?.output).toEqual({ prompt: "ok" });
  });

  it("fails with output-schema-invalid (Step 3 enforce) when the envelope-v1 value violates the schema", async () => {
    const returned = { outcome: "success", value: { wrong: "shape" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({
        resultFormat: "envelope-v1",
        output: { schema: "./output.schema.json" },
      }),
      promptTemplate: "",
      outputSchema: { ...VALUE_SCHEMA },
      handler: async () => returned,
    };

    const result = await executeTurn(
      input("sess-fn-bad"),
      [loaded.manifest],
      makeDeps(loaded),
    );

    // Deliberate change from Step 0: envelope-v1 no longer warns — it enforces.
    const runtimeResult = result.runtimeResults[0];
    expect(runtimeResult?.status).toBe("failed");
    expect(runtimeResult?.error).toContain("output-schema-invalid");
  });

  it("observes (warns once, result unchanged) legacy runtimes with a violating return", async () => {
    // No resultFormat → legacy default. Task 4 (docs 02 §4.3) validates the
    // WHOLE preserved object observe-only: a declared schema now warns on a
    // mismatch but leaves the result byte-identical.
    const returned = { value: { wrong: "shape" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({ output: { schema: "./output.schema.json" } }),
      promptTemplate: "",
      outputSchema: { ...VALUE_SCHEMA },
      handler: async () => returned,
    };

    const result = await executeTurn(
      input("sess-fn-legacy"),
      [loaded.manifest],
      makeDeps(loaded),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain("fn-plugin/observer");
    expect(message).toContain("did not match output.schema");
    // Observe-only: the returned output is passed through untouched.
    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(result.runtimeResults[0]?.output).toEqual(returned);
  });

  it("skips when envelope-v1 is declared but no output.schema was loaded", async () => {
    const returned = { outcome: "success", value: { wrong: "shape" } };
    const loaded: LoadedRuntime = {
      manifest: manifest({ resultFormat: "envelope-v1" }),
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
