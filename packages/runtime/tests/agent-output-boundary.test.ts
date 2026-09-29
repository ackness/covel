import { describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { finalizeAgentOutput } from "../src/agent-loop/finalize-agent-output.js";

const manifest = {
  name: "probe/agent",
  pluginId: "probe",
  runtimeType: "agent",
  outputKind: "plugin",
  stage: "setup",
  trigger: { type: "auto" },
} as RuntimeManifest;

describe("agent output boundary", () => {
  it("checks the raw envelope, then separates declared and tool-emitted effects", () => {
    const declaredEvent = { topic: "world.changed", data: { value: 1 } };
    const toolEvent = { topic: "world.updated", data: { value: 2 } };
    const worldEvent = { id: "birth", description: "a world fact" };
    let schemaInput: Record<string, unknown> | undefined;
    const schemaGate = vi.fn(
      ({ output }: { output: Record<string, unknown> }) => {
        schemaInput = structuredClone(output);
        return undefined;
      },
    );
    const finalized = finalizeAgentOutput({
      manifest,
      finalContent: JSON.stringify({
        name: "Atlas",
        events: [worldEvent, declaredEvent],
        interactions: [{ interactionId: "declared", type: "form" }],
        ui: [{ id: "declared-ui", type: "form" }],
        statePatches: [{ table: "world", field: "name", value: "Atlas" }],
        pluginData: [{ namespace: "world", key: "name", value: "Atlas" }],
        assetGenerations: [{ ref: "asset-1", modality: "image" }],
        notifications: [{ message: "Ready" }],
        preGameDone: true,
      }),
      executedToolCalls: [
        {
          name: "show-form",
          arguments: "{}",
          success: true,
          result: {
            interaction: { interactionId: "tool", type: "form" },
            ui: [{ id: "tool-ui", type: "form" }],
          },
        },
      ],
      failedToolCalls: [],
      pendingProposals: [],
      emittedEvents: [toolEvent],
      schemaGate,
    });

    expect(schemaGate).toHaveBeenCalledOnce();
    expect(schemaInput).toMatchObject({
      events: [worldEvent, declaredEvent],
      preGameDone: true,
      statePatches: expect.any(Array),
    });
    expect(finalized.kind).toBe("ok");
    if (finalized.kind !== "ok") return;
    expect(finalized.output).toEqual({
      name: "Atlas",
      events: [worldEvent],
    });
    expect(finalized.effects).toEqual({
      events: [declaredEvent, toolEvent],
      interactions: [{ interactionId: "tool", type: "form" }],
      ui: [
        { id: "declared-ui", type: "form" },
        { id: "tool-ui", type: "form" },
      ],
      statePatches: [{ table: "world", field: "name", value: "Atlas" }],
      pluginData: [{ namespace: "world", key: "name", value: "Atlas" }],
      assetGenerations: [{ ref: "asset-1", modality: "image" }],
      notifications: [{ message: "Ready" }],
    });
    expect(finalized.completion).toBe("done");
  });

  it("preserves a WorldIR events array without a topic as business output", () => {
    const events = [{ id: "birth", description: "a world fact" }];
    const finalized = finalizeAgentOutput({
      manifest,
      finalContent: JSON.stringify({ schemaVersion: 1, events }),
      executedToolCalls: [],
      failedToolCalls: [],
      pendingProposals: [],
    });
    expect(finalized).toEqual({
      kind: "ok",
      output: { schemaVersion: 1, events },
    });
  });

  it("prefers tool interactions over a declared duplicate and dedupes resumed tools", () => {
    const finalized = finalizeAgentOutput({
      manifest,
      finalContent: JSON.stringify({
        interactions: [{ interactionId: "same", type: "form" }],
      }),
      priorToolCalls: [
        {
          toolCallId: "before-suspend",
          toolName: "form-tool",
          pluginId: "probe",
          runtimeId: "probe/agent",
          turnId: "turn",
          input: {},
          output: {
            interaction: { interactionId: "same", type: "form" },
            ui: [{ id: "card", type: "form" }],
          },
          durationMs: 1,
          approvalStatus: "auto-allowed",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      executedToolCalls: [
        {
          name: "form-tool",
          arguments: "{}",
          result: {
            interaction: { interactionId: "same", type: "form" },
            ui: [{ id: "card", type: "form" }],
          },
          success: true,
        },
      ],
      failedToolCalls: [],
      pendingProposals: [],
      dedupeInteractions: true,
    });
    expect(finalized).toEqual({
      kind: "ok",
      output: {},
      effects: {
        interactions: [{ interactionId: "same", type: "form" }],
        ui: [{ id: "card", type: "form" }],
      },
    });
  });
});
