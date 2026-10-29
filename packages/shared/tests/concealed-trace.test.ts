import { describe, expect, it } from "vitest";
import { concealTracePayload } from "../src/index.js";

describe("concealTracePayload", () => {
  it("keeps a step event's content-free fields and drops its tool names", () => {
    const concealed = concealTracePayload({
      runtimeId: "plug/hidden",
      pluginId: "plug",
      turnId: "turn",
      runId: "run",
      step: 2,
      durationMs: 12,
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2 },
      toolCalls: [{ name: "reveal-secret", success: true }],
      retries: [{ attempt: 1, reason: "transient-error" }],
      notes: [{ kind: "tool-narrowed", count: 1, ignored: 1 }],
      stopReason: "max-steps",
      finalizer: true,
      toolChoice: { name: "reveal-secret" },
    });
    expect(concealed).toEqual({
      concealed: true,
      runtimeId: "plug/hidden",
      pluginId: "plug",
      turnId: "turn",
      runId: "run",
      step: 2,
      durationMs: 12,
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2 },
      retries: [{ attempt: 1, reason: "transient-error" }],
      notes: [{ kind: "tool-narrowed", count: 1, ignored: 1 }],
      stopReason: "max-steps",
      finalizer: true,
    });
    expect(JSON.stringify(concealed)).not.toContain("reveal-secret");
  });
});

it("preserves the repair identity and note without exposing content", () => {
  expect(
    concealTracePayload({
      step: 2,
      repair: true,
      notes: [{ kind: "output-repair" }],
      text: "private draft",
      messages: [{ role: "system", content: "private errors" }],
    }),
  ).toEqual({
    concealed: true,
    step: 2,
    repair: true,
    notes: [{ kind: "output-repair" }],
  });
});
