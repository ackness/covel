import { describe, expect, it } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { buildTurnDigest } from "../src/turn-executor/turn-digest.js";

const story = { name: "story", outputKind: "story" } as RuntimeManifest;
const result = (overrides: Partial<RuntimeResult> = {}): RuntimeResult => ({
  runtimeId: "story",
  pluginId: "story",
  runId: "run",
  turnId: "current",
  status: "success",
  output: { narrativeOutput: "Current story" },
  toolCalls: [],
  durationMs: 0,
  timestamp: "now",
  ...overrides,
});

describe("kernel turn digest", () => {
  it("freezes only successful source-turn story and accepted tool summaries", () => {
    const live = result();
    const digest = buildTurnDigest(
      { sessionId: "s", turnId: "current", playerMessage: "Go", locale: "en" },
      [
        live,
        result({ turnId: "previous" }),
        result({ status: "failed" }),
        result({ runtimeId: "skipped", status: "skipped" }),
        result({ runtimeId: "waiting", status: "pending" }),
        result({ runtimeId: "running", status: "running" }),
        result({ runtimeId: "helper" }),
      ],
      [story],
    );
    expect(digest).toEqual({
      turnId: "current",
      playerMessage: "Go",
      locale: "en",
      narrativeText: "Current story",
      lastPlayerInput: null,
      runtimeResults: [
        { runtimeId: "story", status: "success" },
        { runtimeId: "story", status: "failed" },
        { runtimeId: "skipped", status: "skipped" },
        { runtimeId: "helper", status: "success" },
      ],
      toolCallSummaries: [],
    });
    live.output!.narrativeOutput = "Mutated afterwards";
    expect(digest.narrativeText).toBe("Current story");
    expect(Object.isFrozen(digest)).toBe(true);
    expect(Object.isFrozen(digest.toolCallSummaries)).toBe(true);
  });

  it("keeps explicit empty story output so the plugin can skip without querying later state", () => {
    const digest = buildTurnDigest(
      { sessionId: "s", turnId: "current", playerMessage: "Only a form" },
      [result({ runtimeId: "form" })],
      [story],
    );
    expect(digest.narrativeText).toBe("");
    expect(digest.playerMessage).toBe("Only a form");
  });
});
