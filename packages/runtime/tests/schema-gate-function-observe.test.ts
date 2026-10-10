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
import type { JsonValue, RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";

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
  return {
    origin: "player",
    sessionId,
    turnId: `${sessionId}-turn`,
    playerMessage: "hi",
  };
}

function makeDeps(loaded: LoadedRuntime): TurnExecutorDeps {
  return {
    loadRuntime: async () => loaded,
    llm: {
      generate: async () => {
        throw new Error("Function runtimes do not use the LLM");
      },
    },
    store: createMemoryStore(),
  };
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
    const returned = { outcome: "success" as const, value: { prompt: "ok" } };
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
    const returned = { outcome: "success" as const, value: { wrong: "shape" } };
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
    const returned = { outcome: "success" as const, value: { wrong: "shape" } };
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

  it.each([undefined, { type: "object" }])(
    "enforces the public contract regardless of output.schema %j",
    async (outputSchema) => {
      const loaded: LoadedRuntime = {
        manifest: manifest({ outputContract: "prompt@1" }),
        promptTemplate: "",
        outputSchema,
        outputContractSchema: VALUE_SCHEMA,
        handler: async () => ({
          outcome: "success",
          value: { wrong: "shape" },
        }),
      };
      const onRuntimeComplete = vi.fn();
      const result = await executeTurn(
        input("sess-contract"),
        [loaded.manifest],
        {
          ...makeDeps(loaded),
          onRuntimeComplete,
        },
      );
      expect(result.runtimeResults[0]).toMatchObject({
        status: "failed",
        output: null,
        error: expect.stringContaining("contract-output-invalid"),
      });
      expect(onRuntimeComplete).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    },
  );

  it.each(["valid", "invalid"])(
    "validates guard-provided contract output (%s)",
    async (shape) => {
      const loaded: LoadedRuntime = {
        manifest: manifest({
          runtimeType: "agent",
          outputContract: "prompt@1",
        }),
        promptTemplate: "",
        outputContractSchema: VALUE_SCHEMA,
        guard: async () => ({
          skip: true,
          ...(shape === "valid" ? { prompt: "ok" } : { wrong: "shape" }),
        }),
      };
      const result = await executeTurn(
        input("sess-guard-contract"),
        [loaded.manifest],
        makeDeps(loaded),
      );
      expect(result.runtimeResults[0]).toMatchObject(
        shape === "valid"
          ? { status: "skipped", output: { skip: true, prompt: "ok" } }
          : {
              status: "failed",
              output: null,
              error: expect.stringContaining("contract-output-invalid"),
            },
      );
    },
  );

  it("validates a guard-provided output without its skip flag against a strict contract", async () => {
    const loaded: LoadedRuntime = {
      manifest: manifest({ runtimeType: "agent", outputContract: "prompt@1" }),
      promptTemplate: "",
      outputContractSchema: { ...VALUE_SCHEMA, additionalProperties: false },
      guard: async () => ({ skip: true, prompt: "ok" }),
    };
    const result = await executeTurn(
      input("sess-guard-strict"),
      [loaded.manifest],
      makeDeps(loaded),
    );
    expect(result.runtimeResults[0]).toMatchObject({
      status: "skipped",
      output: { skip: true, prompt: "ok" },
    });
  });

  it.each([false, true])(
    "validates PostRuntime output including recovered failures (throws=%s)",
    async (throws) => {
      const loaded: LoadedRuntime = {
        manifest: manifest({ outputContract: "prompt@1" }),
        promptTemplate: "",
        outputContractSchema: VALUE_SCHEMA,
        handler: async () => {
          if (throws) throw new Error("Handler failed");
          return { outcome: "success", value: { prompt: "ok" } };
        },
      };
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "rewrite-output",
        event: "PostRuntime",
        handler: async (_context, payload) => ({
          action: "continue",
          replace: {
            result: {
              ...(payload as { result: Record<string, unknown> }).result,
              status: "success",
              output: { wrong: "shape" },
            },
          },
        }),
      });
      const result = await executeTurn(
        input("sess-hook-contract"),
        [loaded.manifest],
        {
          ...makeDeps(loaded),
          hookPipeline,
        },
      );
      expect(result.runtimeResults[0]).toMatchObject({
        status: "failed",
        output: null,
        error: expect.stringContaining("contract-output-invalid"),
      });
    },
  );

  it.each([true, false])(
    "commits buffered writes, domain effects and exports only for valid contract output (valid=%s)",
    async (valid) => {
      const sessionId = "sess-contract-commit";
      const store = createMemoryStore();
      await store.createSession({
        locale: "en-US",
        updatedAt: "2026-01-01T00:00:00.000Z",
        id: sessionId,
        status: "active",
        phase: "playing",
        completedPlayerTurns: 1,
        setupRuntimes: {},
        activePlugins: ["fn-plugin"],
        createdAt: new Date().toISOString(),
      });
      const loaded: LoadedRuntime = {
        manifest: manifest({
          outputContract: "prompt@1",
          output: { schema: "./own.json", recordAs: "prompt" },
        }),
        promptTemplate: "",
        outputSchema: { type: "object" },
        outputContractSchema: VALUE_SCHEMA,
        handler: async (ctx) => {
          await ctx.pluginData!.set("notes", "buffered", { text: "buffered" });
          const value: JsonValue = valid
            ? { prompt: "ok" }
            : { wrong: "shape" };
          return {
            outcome: "success" as const,
            value,
            effects: {
              pluginData: [
                {
                  namespace: "notes",
                  key: "effect",
                  value: { text: "effect" },
                },
              ],
            },
          };
        },
      };
      const result = await executeTurn(input(sessionId), [loaded.manifest], {
        ...makeDeps(loaded),
        store,
      });
      expect(result.runtimeResults[0]?.status).toBe(
        valid ? "success" : "failed",
      );
      expect(
        await store.getPluginData(sessionId, "fn-plugin", "notes", "buffered"),
      ).toBeNull();
      await finalizeExecution({
        store,
        sessionId,
        runtimes: [loaded.manifest],
        results: result.runtimeResults,
        turnIds: [input(sessionId).turnId],
        executionContext: {
          executionId: "contract-commit",
          origin: "manual",
          countPolicy: "none",
        },
        loadOutputSchema: async () => loaded.outputSchema,
      });
      for (const key of ["buffered", "effect"]) {
        const row = await store.getPluginData(
          sessionId,
          "fn-plugin",
          "notes",
          key,
        );
        expect(Boolean(row)).toBe(valid);
      }
      const exported = await store.getLatestRuntimeExport(
        sessionId,
        loaded.manifest.name,
        "prompt",
      );
      expect(Boolean(exported)).toBe(valid);
    },
  );

  it.each(["schema", "loader", "hostile-loader"])(
    "emits one failed terminal when public contract %s validation throws after PostRuntime",
    async (failure) => {
      const loaded: LoadedRuntime = {
        manifest: manifest({ outputContract: "prompt@1" }),
        promptTemplate: "",
        outputContractSchema: { $ref: "#/definitions/missing" },
        handler: async () => {
          if (failure !== "schema") throw new Error("Handler failed");
          return { outcome: "success", value: { prompt: "ok" } };
        },
      };
      const postRuntime = vi.fn(async (_context, payload) => ({
        action: "continue" as const,
        replace: {
          result: {
            ...(payload as { result: Record<string, unknown> }).result,
            status: "success",
            output: { prompt: "recovered" },
          },
        },
      }));
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "recover",
        event: "PostRuntime",
        handler: postRuntime,
      });
      const onRuntimeComplete = vi.fn();
      const loadRuntime = vi.fn(async () => loaded);
      if (failure !== "schema") {
        loadRuntime.mockResolvedValueOnce(loaded).mockRejectedValue(
          failure === "loader"
            ? new Error("Contract loader failed")
            : {
                get message() {
                  throw new Error("Do not inspect error.message");
                },
                toString() {
                  throw new Error("Do not stringify the rejection");
                },
              },
        );
      }
      const result = await executeTurn(
        input("sess-contract-throw"),
        [loaded.manifest],
        {
          ...makeDeps(loaded),
          hookPipeline,
          onRuntimeComplete,
          loadRuntime,
        },
      );
      expect(result.runtimeResults[0]).toMatchObject({
        status: "failed",
        output: null,
        error: expect.stringContaining("contract-output-invalid"),
      });
      expect(result.runtimeResults[0]?.error).toContain(
        "contract schema could not be loaded or compiled",
      );
      expect(postRuntime).toHaveBeenCalledTimes(1);
      expect(onRuntimeComplete).toHaveBeenCalledTimes(1);
      expect(onRuntimeComplete).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    },
  );
});
