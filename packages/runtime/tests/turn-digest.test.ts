import { describe, expect, it } from "vitest";
import type {
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
} from "@covel/shared";
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
  it("excludes concealed runtime tool arguments while retaining public calls and terminal statuses", () => {
    const call = (
      toolName: string,
      input: ToolCallRecord["input"],
    ): ToolCallRecord => ({
      toolCallId: toolName,
      toolName,
      pluginId: "planner",
      runtimeId: `planner/${toolName === "plan" ? "private" : "public"}`,
      turnId: "current",
      input,
      output: { success: true },
      approvalStatus: "auto-allowed" as const,
      durationMs: 0,
      timestamp: "now",
    });
    const digest = buildTurnDigest(
      {
        origin: "player",
        sessionId: "s",
        turnId: "current",
        playerMessage: "Go",
      },
      [
        result({
          runtimeId: "planner/private",
          toolCalls: [call("plan", { secret: "hidden betrayal" })],
        }),
        result({
          runtimeId: "planner/public",
          toolCalls: [call("record", { fact: "gate opened" })],
        }),
      ],
      [
        {
          name: "planner/private",
          pluginId: "planner",
          description: "Private planning",
          concealed: true,
        },
        {
          name: "planner/public",
          pluginId: "planner",
          description: "Public record",
        },
      ],
    );
    expect(digest.toolCallSummaries).toEqual([
      '[record] {"fact":"gate opened"}',
    ]);
    expect(JSON.stringify(digest)).not.toContain("hidden betrayal");
    expect(digest.runtimeResults).toEqual([
      { runtimeId: "planner/private", status: "success" },
      { runtimeId: "planner/public", status: "success" },
    ]);
  });

  it("freezes only successful source-turn story and accepted tool summaries", () => {
    const live = result();
    const digest = buildTurnDigest(
      {
        origin: "player",
        sessionId: "s",
        turnId: "current",
        playerMessage: "Go",
        locale: "en",
      },
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
      actions: [],
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
    Object.assign(live.output!, { narrativeOutput: "Mutated afterwards" });
    expect(digest.narrativeText).toBe("Current story");
    expect(Object.isFrozen(digest)).toBe(true);
    expect(Object.isFrozen(digest.toolCallSummaries)).toBe(true);
  });

  it("keeps explicit empty story output so the plugin can skip without querying later state", () => {
    const digest = buildTurnDigest(
      {
        origin: "player",
        sessionId: "s",
        turnId: "current",
        playerMessage: "Only a form",
      },
      [result({ runtimeId: "form" })],
      [story],
    );
    expect(digest.narrativeText).toBe("");
    expect(digest.playerMessage).toBe("Only a form");
  });
});
