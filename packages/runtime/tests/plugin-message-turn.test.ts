import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { getPendingProposals, withPendingProposals } from "@covel/tools";
import type { ExecutionContext, Proposal } from "@covel/shared";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { anchorPluginMessage } from "../src/commit/plugin-message-turn.js";

const sessionId = "message-session";
const turnId = "retry-execution";
const pluginId = "external-cards";
const source = { pluginId, runtimeId: `${pluginId}/cards` };

function proposal(
  items: Array<{ namespace: string; key: string; value: unknown }>,
): Proposal {
  return {
    id: "write-cards",
    type: "plugin.data.batch",
    source,
    turnId,
    sessionId,
    timestamp: "2026-01-01T00:00:00Z",
    payload: { items },
  };
}

async function commit(
  options: {
    retry?: boolean;
    story?: boolean;
    rollback?: boolean;
    functionOutput?: boolean;
  } = {},
) {
  const store = createMemoryStore();
  const items = [
    { namespace: "message", key: "__turnId", value: turnId },
    { namespace: "message", key: "prompt1Text", value: "Inspect the door" },
    { namespace: "history", key: "__turnId", value: turnId },
  ];
  const context: ExecutionContext = createExecutionContext({
    sessionId,
    turnId,
    origin: "manual",
    playerMessage: "",
    ...(options.retry === false
      ? {}
      : {
          manualTrigger: {
            runtimeId: source.runtimeId,
            sourceTurnId: "story-source",
          },
        }),
  });
  const card = {
    ...source,
    turnId,
    status: "success",
    toolCalls: [],
    output: options.functionOutput
      ? { pluginData: items }
      : withPendingProposals({}, [proposal(items)]),
  };
  const outcome = await finalizeExecution({
    store,
    sessionId,
    executionContext: context,
    turnIds: [],
    runtimes: [
      { ...source, name: source.runtimeId, outputKind: "plugin" },
      {
        pluginId: "external-story",
        name: "external-story",
        outputKind: "story",
      },
    ],
    results: [
      card,
      ...(options.story
        ? [
            {
              pluginId: "external-story",
              runtimeId: "external-story",
              turnId,
              status: "success",
              output: { narrativeOutput: "A newly generated scene." },
            },
          ]
        : []),
    ],
    ...(options.rollback
      ? {
          extraInTx: async () => {
            throw new Error("rollback");
          },
        }
      : {}),
  });
  return { store, outcome, card };
}

describe("third-party message anchors at the commit boundary", () => {
  it.each(["plugin.data", "plugin.data.batch"] as const)(
    "anchors per-turn records in %s while retaining proposal identity",
    (type) => {
      const item = {
        namespace: "message",
        key: turnId,
        value: { __turnId: turnId, checks: ["success"] },
      };
      const base = proposal([item]);
      const input =
        type === "plugin.data" ? { ...base, type, payload: item } : base;
      const result = anchorPluginMessage(input, "source");
      expect(result.turnId).toBe(turnId);
      const payload =
        result.type === "plugin.data"
          ? result.payload
          : result.type === "plugin.data.batch"
            ? result.payload.items[0]
            : null;
      expect(payload).toMatchObject({
        namespace: "message",
        key: "source",
        value: { __turnId: "source", checks: ["success"] },
      });
      expect(item.value.__turnId).toBe(turnId);
    },
  );

  it("preserves an explicit anchor to other content", () => {
    const input = proposal([
      { namespace: "message", key: "__turnId", value: "explicit-anchor" },
    ]);
    expect(anchorPluginMessage(input, "source")).toEqual(input);
  });
  it.each([false, true])(
    "anchors %s function output to the source without changing audit identity",
    async (functionOutput) => {
      const { store, outcome, card } = await commit({ functionOutput });
      expect(outcome.status).toBe("committed");
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "__turnId"))
          ?.value,
      ).toBe("story-source");
      expect(
        (await store.getPluginData(sessionId, pluginId, "history", "__turnId"))
          ?.value,
      ).toBe(turnId);
      expect(card.turnId).toBe(turnId);
      const original = functionOutput
        ? card.output
        : getPendingProposals(card.output);
      expect(JSON.stringify(original)).toContain(turnId);
    },
  );

  it.each([{ retry: false }, { story: true }])(
    "keeps the actual turn for ordinary calls and a new story: %j",
    async (options) => {
      const { store, outcome } = await commit(options);
      expect(outcome.status).toBe("committed");
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "__turnId"))
          ?.value,
      ).toBe(turnId);
    },
  );

  it("does not publish message data on a failed commit", async () => {
    const { store, outcome } = await commit({ rollback: true });
    expect(outcome.status).toBe("failed");
    expect(
      await store.getPluginData(sessionId, pluginId, "message", "__turnId"),
    ).toBeNull();
  });
});
