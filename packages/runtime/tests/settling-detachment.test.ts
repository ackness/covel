import { describe, expect, it } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import {
  detachedUpstreamResults,
  planTurnDetachment,
} from "../src/schedule/turn-completion.js";

const manifest = (overrides: Partial<RuntimeManifest> = {}): RuntimeManifest =>
  ({
    name: "memory/update",
    pluginId: "memory",
    description: "memory update",
    stage: "post-turn",
    runtimeType: "function",
    handler: "./handler.js",
    outputKind: "plugin",
    trigger: { type: "auto" },
    turnCompletion: { mode: "detached", settle: "before-next-execution" },
    effects: {
      reads: ["plugin-data:self:blocks"],
      writes: ["plugin-data:self:blocks"],
    },
    ...overrides,
  }) as RuntimeManifest;

describe("settling detachment admission", () => {
  it("allows live own-namespace reads only behind the settle barrier", () => {
    const settling = manifest();
    expect(
      planTurnDetachment([settling]).eligibleRuntimeIds.has(settling.name),
    ).toBe(true);
    expect(
      planTurnDetachment([manifest({ turnCompletion: { mode: "detached" } })])
        .eligibleRuntimeIds.size,
    ).toBe(0);
  });

  it.each([
    { stage: "narrative" },
    { outputKind: "story" },
    { runtimeType: "agent" },
    { effects: { reads: ["state:*"], writes: ["plugin-data:self:blocks"] } },
    { effects: { writes: ["state:*"] } },
  ] as Partial<RuntimeManifest>[])(
    "preserves the detached boundary for %j",
    (override) => {
      expect(
        planTurnDetachment([manifest(override)]).eligibleRuntimeIds.size,
      ).toBe(0);
    },
  );
});

describe("detached upstream payload", () => {
  const result = (runtimeId: string) =>
    ({
      pluginId: runtimeId.split("/")[0]!,
      runtimeId,
      runId: `run-${runtimeId}`,
      turnId: "turn-1",
      status: "success",
      output: { narrativeOutput: `${runtimeId} text` },
      toolCalls: [{ id: "call-1" }],
      durationMs: 5,
      timestamp: "2024-01-01T00:00:00Z",
    }) as unknown as RuntimeResult;

  it("keeps outputs only for declared dependencies and drops tool calls", () => {
    const consumer = manifest({ needs: [{ runtime: "narrator" }] });
    const narrator = manifest({ name: "narrator", pluginId: "narrator" });
    const codex = manifest({ name: "codex", pluginId: "codex" });
    const [kept, reduced] = detachedUpstreamResults(
      consumer,
      [result("narrator"), result("codex")],
      [consumer, narrator, codex],
    );
    expect(kept).toMatchObject({
      runtimeId: "narrator",
      output: { narrativeOutput: "narrator text" },
      toolCalls: [],
    });
    expect(reduced).toEqual({
      pluginId: "codex",
      runtimeId: "codex",
      runId: "run-codex",
      turnId: "turn-1",
      status: "success",
      output: null,
      toolCalls: [],
      durationMs: 5,
      timestamp: "2024-01-01T00:00:00Z",
    });
  });
});
