import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer.js";
import { pluginMessageTurnResolver } from "../plugin-message-turn.js";
import { filterStalePrompts } from "../../../components/session/stage/stage-selectors.js";
import type { ExecutionStep, SessionState, StreamMessage } from "../types.js";

const story: StreamMessage = {
  id: "story",
  role: "assistant",
  content: "A sealed door",
  kind: "story",
  turnId: "source",
  timestamp: "2026-01-01T00:00:00Z",
};
const retry: ExecutionStep = {
  pluginId: "external",
  runtimeId: "external/cards",
  turnId: "retry",
  sourceTurnId: "source",
  status: "completed",
  attemptStatus: "committed",
};
const namespace = { __turnId: "retry", prompt1Text: "Inspect the door" };

function state(): SessionState {
  return {
    ...initialState,
    messages: [story],
    messageUiSpecs: [
      {
        pluginId: "external",
        specs: [
          {
            id: "cards",
            label: "Cards",
            view: { component: "Text", props: { content: "Inspect the door" } },
          },
        ],
      },
    ],
    pluginData: { external: { message: namespace } },
  };
}

describe("legacy third-party message recovery", () => {
  it.each([true, false])(
    "reanchors cards when retry metadata arrives before data: %s",
    (stepsFirst) => {
      let current = state();
      if (stepsFirst)
        current = reducer(current, {
          type: "LOAD_EXECUTION_STEPS",
          steps: [retry],
        });
      current = reducer(current, {
        type: "REPLACE_PLUGIN_DATA",
        pluginData: current.pluginData,
      });
      if (!stepsFirst)
        current = reducer(current, {
          type: "LOAD_EXECUTION_STEPS",
          steps: [retry],
        });
      expect(current.messages.map((m) => m.id)).toEqual([
        "story",
        "plugin-message:external:source",
      ]);
      expect(current.messages[1]?.turnId).toBe("source");
      expect(
        filterStalePrompts(
          namespace,
          "source",
          pluginMessageTurnResolver(current.executionSteps, current.messages),
        ),
      ).toBe(namespace);
      expect(current.pluginData.external?.message?.__turnId).toBe("retry");
    },
  );

  it("waits for commit evidence and reprojects when the attempt commits", () => {
    let current = reducer(state(), {
      type: "LOAD_EXECUTION_STEPS",
      steps: [{ ...retry, attemptStatus: "pending" }],
    });
    expect(
      filterStalePrompts(
        namespace,
        "source",
        pluginMessageTurnResolver(current.executionSteps, current.messages),
      ),
    ).toEqual({});
    current = reducer(current, {
      type: "SET_TURN_ATTEMPT_STATUS",
      turnId: "retry",
      status: "committed",
    });
    expect(current.messages[1]?.turnId).toBe("source");
  });

  it("keeps an old repaired card stale after the story advances", () => {
    const resolve = pluginMessageTurnResolver(
      [retry],
      [story, { ...story, id: "new", turnId: "new" }],
    );
    expect(filterStalePrompts(namespace, "new", resolve)).toEqual({});
  });

  it.each(["failed", "interrupted", "pending"] as const)(
    "does not accept a %s attempt",
    (attemptStatus) => {
      const resolve = pluginMessageTurnResolver(
        [{ ...retry, attemptStatus }],
        [story],
      );
      expect(filterStalePrompts(namespace, "source", resolve)).toEqual({});
    },
  );

  it("anchors newly generated retry stories to their own execution", () => {
    const resolve = pluginMessageTurnResolver(
      [retry],
      [story, { ...story, id: "replacement", turnId: "retry" }],
    );
    expect(resolve("retry")).toBe("retry");
  });

  it("handles legacy retry chains without looping on corrupt links", () => {
    expect(
      pluginMessageTurnResolver(
        [retry, { ...retry, turnId: "retry2", sourceTurnId: "retry" }],
        [story],
      )("retry2"),
    ).toBe("source");
    expect(
      pluginMessageTurnResolver(
        [retry, { ...retry, turnId: "source", sourceTurnId: "retry" }],
        [],
      )("retry"),
    ).toBe("retry");
  });
});
