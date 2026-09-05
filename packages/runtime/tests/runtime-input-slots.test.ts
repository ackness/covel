import { describe, expect, it } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { agentInputSlots } from "../src/agent-loop/runtime-input-slots.js";

describe("declared tool input slots", () => {
  it("projects only declared legacy fields, including deterministic skipped producers", () => {
    const manifest: RuntimeManifest = {
      name: "consumer",
      pluginId: "consumer",
      description: "Consumer",
      input: {
        inject: [
          {
            kind: "runtime",
            from: "producer",
            field: "schema",
            as: "<schema-view>",
          },
        ],
      },
    };
    const source: RuntimeResult = {
      pluginId: "producer",
      runtimeId: "producer",
      runId: "result-1",
      turnId: "turn-1",
      status: "skipped",
      output: { schema: { attributes: [] }, unrelated: "hidden" },
      toolCalls: [],
      durationMs: 1,
      timestamp: "2026-09-05T00:00:00Z",
    };
    const slots = agentInputSlots(
      manifest,
      new Map([
        ["producer", source],
        ["other", { ...source, output: { secret: "unrelated data" } }],
      ]),
    );
    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots["schema-view"])).toBe(true);
    expect(Object.isFrozen(source.output)).toBe(false);
    expect(slots).toEqual({
      "schema-view": {
        cardinality: "one",
        value: { attributes: [] },
        source: {
          pluginId: "producer",
          runtimeId: "producer",
          resultId: "result-1",
        },
      },
    });
    expect(
      agentInputSlots(
        { ...manifest, input: undefined },
        new Map([["producer", source]]),
      ),
    ).toEqual({});
  });
});
