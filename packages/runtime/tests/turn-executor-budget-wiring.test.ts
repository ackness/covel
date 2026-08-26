/**
 * Wiring tests for the context-budget plumbing in turn-executor.
 *
 * The budget pass runs whenever both `estimator` and `contextBudget` are
 * supplied — including for tool-declaring runtimes. Those were previously
 * excluded because prefix pruning could split an assistant↔tool pair; pruning
 * now drops orphaned leading tool messages, so the exclusion (which covered
 * every main agent, i.e. the runtimes that actually dominate long-session
 * token spend) is gone.
 *
 * Turn-executor's job is to thread the dependency references through to the
 * prompt assembler before the LLM is called. These tests therefore observe the
 * actual LLM input: old history must be pruned, the protected user/tool tail
 * must survive, and a prefix cut must never leave an orphaned tool message.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { TokenEstimator } from "@covel/context";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

const SESSION_ID = "sess-budget-wire";
const BUDGET = {
  maxInputTokens: 8_000,
  reservedForResponse: 0,
  protectLastUserTurns: 2,
} as const;

const OLD_USER = "old-user-prune-me";
const OLD_ASSISTANT = "old-assistant-prune-me";
const OLD_TOOL = "old-tool-orphan-prune-me";
const RECENT_USER = "recent-user-must-survive";
const RECENT_ASSISTANT = "recent-assistant-must-survive";
const RECENT_TOOL = "recent-tool-result-must-survive";
const CURRENT_USER = "current-user-must-survive";

// Prime a playing-session history that exceeds the budget. The first tool
// result becomes orphaned when its requesting assistant message is pruned;
// the final user/assistant/tool sequence is protected by the last-two-user
// turns rule, together with the current player message appended by the prompt
// builder.
async function createMainLoopStore(sessionId: string) {
  const store = createMemoryStore();
  const append = async (
    id: string,
    sourceType: string,
    role: string,
    content: string,
    order: number,
  ) =>
    store.appendTurnMessage({
      id,
      sessionId,
      turnId: "prior-turn",
      sourceType,
      role,
      content,
      order,
      createdAt: `2024-01-01T00:00:0${order}Z`,
    });

  // Each old entry is deliberately huge: the protected tail and system prompt
  // fit comfortably, but the prefix cannot fit within BUDGET.
  const oldPayload = "x".repeat(20_000);
  await append("old-user", "player", "user", `${OLD_USER} ${oldPayload}`, 0);
  await append(
    "old-assistant",
    "runtime",
    "assistant",
    `${OLD_ASSISTANT} ${oldPayload}`,
    1,
  );
  await append("old-tool", "tool", "tool", `${OLD_TOOL} ${oldPayload}`, 2);
  await append("recent-user", "player", "user", RECENT_USER, 3);
  await append("recent-assistant", "runtime", "assistant", RECENT_ASSISTANT, 4);
  await append("recent-tool", "tool", "tool", RECENT_TOOL, 5);
  return store;
}

// ── Fixtures ─────────────────────────────────────────────────────

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 42, outputTokens: 10 },
  };
}

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-narrator",
    pluginId: "test-narrator",
    description: "Synthetic narrator for budget-wiring tests.",
    stage: "narrative",
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  };
}

function makeLoaded(manifest: RuntimeManifest): LoadedRuntime {
  return {
    manifest,
    promptTemplate: "You are narrating. Current message: {{ player.message }}.",
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: SESSION_ID,
    turnId: "turn-1",
    playerMessage: CURRENT_USER,
    ...overrides,
  };
}

async function makeBaseDeps(
  llm: RecordingLLM,
  manifest: RuntimeManifest,
): Promise<TurnExecutorDeps> {
  return {
    loadRuntime: async () => makeLoaded(manifest),
    llm,
    store: await createMainLoopStore(SESSION_ID),
  };
}

class RecordingLLM implements LLMAdapter {
  readonly calls: Parameters<LLMAdapter["generate"]>[0][] = [];

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.calls.push(params);
    return makeResponse('{"narrativeOutput":"ok"}');
  }
}

function messageText(content: unknown): string {
  if (typeof content !== "string") {
    throw new Error("This fixture only sends text messages to the LLM");
  }
  return content;
}

function inputTokenCount(
  messages: readonly { readonly content: unknown }[],
  estimator: TokenEstimator,
): number {
  return messages.reduce(
    (total, message) => total + estimator(messageText(message.content)),
    0,
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe("turn-executor → context budget wiring", () => {
  it.each<[string, Partial<RuntimeManifest>]>([
    ["without declared tools", {}],
    [
      "with input.tools",
      {
        input: {
          tools: [{ plugin: "other-plugin", runtime: "other-runtime" }],
        },
      },
    ],
    ["with tools.builtin", { tools: { builtin: ["plugin-data-set"] } }],
    ["with tools.plugin", { tools: { plugin: ["dummy"] } }],
  ])(
    "prunes history before the LLM call %s",
    async (_label, manifestOverrides) => {
      const estimator: TokenEstimator = (text) => text.length;
      const llm = new RecordingLLM();
      const manifest = makeManifest(manifestOverrides);
      const deps: TurnExecutorDeps = {
        ...(await makeBaseDeps(llm, manifest)),
        estimator,
        contextBudget: BUDGET,
      };

      const result = await executeTurn(makeTurnInput(), [manifest], deps);

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
      expect(llm.calls).toHaveLength(1);

      const messages = llm.calls[0]!.messages;
      const contents = messages.map((message) => messageText(message.content));
      expect(contents.join("\n"), contents.join("\n")).toMatch(
        /older messages pruned to stay within token budget/,
      );
      expect(contents).not.toContain(expect.stringContaining(OLD_USER));
      expect(contents).not.toContain(expect.stringContaining(OLD_ASSISTANT));
      expect(contents).not.toContain(expect.stringContaining(OLD_TOOL));

      // The final two user turns and all following messages are protected.
      expect(contents).toContain(RECENT_USER);
      expect(contents).toContain(RECENT_ASSISTANT);
      expect(contents).toContain(RECENT_TOOL);
      expect(contents).toContain(CURRENT_USER);
      const firstNonSystem = messages.find(
        (message) => message.role !== "system",
      );
      expect(firstNonSystem?.role).toBe("user");

      // This fixture's protected tail fits, so the request passed to the LLM
      // must be within the effective input budget, including the prune marker.
      expect(inputTokenCount(messages, estimator)).toBeLessThanOrEqual(
        BUDGET.maxInputTokens - BUDGET.reservedForResponse,
      );
    },
  );
});
