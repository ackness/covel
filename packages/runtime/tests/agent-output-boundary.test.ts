import { describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { finalizeAgentOutput } from "../src/agent-loop/finalize-agent-output.js";

const manifest = {
  name: "probe/agent",
  pluginId: "probe",
  runtimeType: "agent",
  outputKind: "system",
  stage: "setup",
  trigger: { type: "auto" },
} as RuntimeManifest;

describe("agent output boundary", () => {
  it("ignores effects in an accepted model candidate and keeps tool-emitted ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const declaredEvent = { topic: "world.changed", data: { value: 1 } };
    const toolEvent = { topic: "world.updated", data: { value: 2 } };
    const worldEvent = { id: "birth", description: "a world fact" };
    const finalized = finalizeAgentOutput({
      manifest,
      acceptedOutput: {
        name: "Atlas",
        statePatches: [{ table: "world", field: "name", value: "Atlas" }],
        events: [worldEvent, declaredEvent],
        interactions: [{ interactionId: "declared", type: "form" }],
        ui: [
          {
            parts: [
              {
                id: "declared-ui",
                type: "form",
                status: "success",
                content: {},
              },
            ],
          },
        ],
        pluginData: [{ namespace: "world", key: "name", value: "Atlas" }],
        assetGenerations: [{ ref: "asset-1", modality: "image" }],
        notifications: [{ message: "Ready" }],
        preGameDone: true,
      },
      executedToolCalls: [
        {
          name: "show-form",
          arguments: "{}",
          success: true,
          result: {
            interaction: { interactionId: "tool", type: "form" },
            ui: [
              {
                parts: [
                  {
                    id: "tool-ui",
                    type: "form",
                    status: "success",
                    content: {},
                  },
                ],
              },
            ],
          },
        },
      ],
      pendingProposals: [],
      emittedEvents: [toolEvent],
    });

    expect(finalized.kind).toBe("ok");
    if (finalized.kind !== "ok") return;
    expect(finalized.output).toEqual({
      name: "Atlas",
      events: [worldEvent],
    });
    // Only what the whitelisted tools produced: the final JSON is not a
    // second write channel past `agent.tools`.
    expect(finalized.effects).toEqual({
      events: [toolEvent],
      interactions: [{ interactionId: "tool", type: "form" }],
      ui: [
        {
          parts: [
            { id: "tool-ui", type: "form", status: "success", content: {} },
          ],
        },
      ],
    });
    // The completion signal is not an effect.
    expect(finalized.completion).toBe("done");
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    for (const field of [
      "probe/agent",
      "statePatches",
      "pluginData",
      "notifications",
      "assetGenerations",
      "interactions",
      "ui",
      "events[].topic",
    ])
      expect(message).toContain(field);
    warn.mockRestore();
  });

  it("keeps independently owned business-tool effects", () => {
    const finalized = finalizeAgentOutput({
      manifest,
      acceptedOutput: { saved: true },
      executedToolCalls: [
        {
          name: "save",
          arguments: "{}",
          success: true,
          result: { notifications: [{ message: "Saved" }] },
        },
      ],
      pendingProposals: [],
    });
    expect(finalized).toEqual({
      kind: "ok",
      output: { saved: true },
      effects: { notifications: [{ message: "Saved" }] },
    });
  });

  it("preserves a WorldIR events array without a topic as business output", () => {
    const events = [{ id: "birth", description: "a world fact" }];
    const finalized = finalizeAgentOutput({
      manifest,
      acceptedOutput: { schemaVersion: 1, events },
      executedToolCalls: [],
      pendingProposals: [],
    });
    expect(finalized).toEqual({
      kind: "ok",
      output: { schemaVersion: 1, events },
    });
  });

  it("keeps the last successful interaction revision across resume", () => {
    const finalized = finalizeAgentOutput({
      manifest,
      acceptedOutput: {
        interactions: [{ interactionId: "same", type: "form" }],
      },
      executedToolCalls: [
        {
          name: "form-tool",
          arguments: "{}",
          success: true,
          result: {
            interaction: {
              interactionId: "same",
              type: "form",
              title: "Earlier",
            },
            ui: [
              {
                parts: [
                  { id: "card", type: "form", status: "success", content: {} },
                ],
              },
            ],
          },
        },
        {
          name: "form-tool",
          arguments: "{}",
          result: {
            interaction: {
              interactionId: "same",
              type: "form",
              title: "Revised",
            },
            ui: [
              {
                parts: [
                  { id: "card", type: "form", status: "success", content: {} },
                ],
              },
            ],
          },
          success: true,
        },
      ],
      pendingProposals: [],
      dedupeInteractions: true,
    });
    expect(finalized).toEqual({
      kind: "ok",
      output: {},
      effects: {
        interactions: [
          { interactionId: "same", type: "form", title: "Revised" },
        ],
        ui: [
          {
            parts: [
              { id: "card", type: "form", status: "success", content: {} },
            ],
          },
        ],
      },
    });
  });
});
