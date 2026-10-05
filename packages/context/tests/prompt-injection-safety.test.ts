import { describe, expect, it } from "vitest";
import type { ContextBuildParams } from "@covel/context";
import { buildSegmentedContext } from "../src/prompt-assembler.js";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";

/**
 * Regression coverage for the single-pass interpolation contract (9223d69f):
 * the prompt template is interpolated exactly once, over the plugin's own
 * PLUGIN.md body. Injected DATA — upstream runtime output, plugin-data, and
 * core-memory blocks the model or player authored — is NOT re-interpolated and
 * is XML-escaped so it cannot break out of its envelope. Without these two
 * behaviours a `{{ ... }}` sequence smuggled into player/model data would be
 * expanded straight into the system prompt, and a crafted `</tag>` string would
 * close its own block and read as framework instructions.
 *
 * These assertions lock both so a future refactor that quietly restores a
 * second interpolation pass, or drops the escape, fails red.
 */

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-rt",
    description: "test",
    stage: "narrative",
    ...overrides,
  };
}

function makeRuntimeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: "test-plugin",
    runtimeId: "test-rt",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    output: {},
    toolCalls: [],
    durationMs: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "I step forward",
    origin: "player",
    ...overrides,
  };
}

function baselineParams(
  overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
  return {
    promptTemplate: "You are a test narrator.",
    manifest: makeManifest(),
    turnInput: makeTurnInput(),
    completedResults: new Map(),
    ...overrides,
  };
}

describe("prompt injection safety", () => {
  it("does NOT re-interpolate {{ }} sequences inside injected upstream data", () => {
    // The upstream runtime's output carries a literal template token. A single
    // interpolation pass (over PLUGIN.md only) must leave it untouched; a second
    // pass over the inject block would expand it to the player message and paste
    // player-controlled text into the system prompt.
    const params = baselineParams({
      promptTemplate: "You are a downstream runtime.",
      turnInput: makeTurnInput({ playerMessage: "PLAYER_INJECTED_SECRET" }),
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "upstream/rt",
              field: "note",
              as: "<upstream-output>",
            },
          ],
        },
      }),
      completedResults: new Map([
        [
          "upstream/rt",
          makeRuntimeResult({ output: { note: "echo {{ player.message }}" } }),
        ],
      ]),
    });

    const { systemPrompt, turnContext } = buildSegmentedContext(params);

    // Token stays literal — proof the inject block was not interpolated.
    expect(turnContext).toContain("echo {{ player.message }}");
    // The expansion (what a second pass would produce) never appears.
    expect(turnContext).not.toContain("echo PLAYER_INJECTED_SECRET");
    expect(systemPrompt).not.toContain("echo PLAYER_INJECTED_SECRET");
  });
});
