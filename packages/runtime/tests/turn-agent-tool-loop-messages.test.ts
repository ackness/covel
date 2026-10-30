import { describe, expect, it } from "vitest";
import {
  buildAssistantToolCallMessage,
  buildPreToolAbortMessage,
  buildToolExecutionUnavailableMessage,
  buildToolResultMessage,
  buildSuspendedPlaceholderMessage,
  buildSkippedToolMessage,
  buildNestedSuspendMessage,
  buildResumedToolMessage,
} from "../src/agent-loop/turn-agent-tool-loop-messages.js";

describe("turn-agent-tool-loop message helpers", () => {
  it("builds the assistant tool-call message required by the follow-up LLM call", () => {
    const toolCalls = [
      { id: "tc-1", name: "lookup", arguments: '{"topic":"moon"}' },
    ];

    expect(
      buildAssistantToolCallMessage({
        content: null,
        toolCalls,
        reasoningContent: "private reasoning",
      }),
    ).toEqual({
      role: "assistant",
      content: "",
      toolCalls,
      reasoningContent: "private reasoning",
    });
  });

  it("omits reasoningContent when the provider did not return it", () => {
    const message = buildAssistantToolCallMessage({
      content: "use this",
      toolCalls: [{ id: "tc-2", name: "save", arguments: "{}" }],
    });

    expect(message).toEqual({
      role: "assistant",
      content: "use this",
      toolCalls: [{ id: "tc-2", name: "save", arguments: "{}" }],
    });
    expect("reasoningContent" in message).toBe(false);
  });

  it("builds tool-role messages for normal and hook-aborted tool results", () => {
    expect(
      buildToolResultMessage({
        toolCallId: "tc-ok",
        content: '{"data":{"ok":true}}',
      }),
    ).toEqual({
      role: "tool",
      content: '{"data":{"ok":true}}',
      toolCallId: "tc-ok",
    });

    expect(
      JSON.parse(
        buildPreToolAbortMessage({
          toolCallId: "tc-blocked",
          reason: "tool blocked",
        }).content as string,
      ),
    ).toEqual({
      error: {
        code: "refused",
        message: "pre-tool-use hook aborted: tool blocked",
      },
    });
  });

  it("builds the no-executor fallback tool message", () => {
    expect(buildToolExecutionUnavailableMessage("tc-missing")).toEqual({
      role: "tool",
      content:
        '{"error":{"code":"unavailable","message":"Tool execution not available"}}',
      toolCallId: "tc-missing",
    });
  });

  it("builds a suspension placeholder in the success envelope", () => {
    const message = buildSuspendedPlaceholderMessage("suspend-call");
    expect(message).toMatchObject({ role: "tool", toolCallId: "suspend-call" });
    expect(JSON.parse(message.content as string)).toEqual({
      summary: "Suspended: waiting for the player's answer.",
    });
  });

  it.each([
    [
      "suspended",
      "Not run: an earlier call in this response suspended the runtime.",
    ],
    ["terminated", "Not run: an earlier tool result ended the run."],
    ["aborted", "Not run: this tool batch was aborted."],
  ] as const)(
    "builds a cancelled envelope for a call skipped because of %s",
    (reason, text) => {
      const message = buildSkippedToolMessage({
        toolCallId: "skipped-call",
        reason,
      });
      expect(message).toMatchObject({
        role: "tool",
        toolCallId: "skipped-call",
      });
      expect(JSON.parse(message.content as string)).toEqual({
        error: { code: "cancelled", message: text },
      });
    },
  );

  it("builds a nested-suspend error with guidance", () => {
    expect(
      JSON.parse(buildNestedSuspendMessage("nested-call").content as string),
    ).toEqual({
      error: {
        code: "unavailable",
        message: "Suspending is not supported inside a sub-agent run.",
        hint: "Continue without asking the player, or finish with what you have.",
      },
    });
  });

  it("builds a resume success envelope and projects the player's data", () => {
    const message = buildResumedToolMessage("suspend-call", {
      answer: "yes",
      id: "86c20348-fbb5-4908-bc84-9954441a60c0",
      changedAt: "2026-10-30T12:00:00.000Z",
    });
    expect(message).toMatchObject({ role: "tool", toolCallId: "suspend-call" });
    expect(JSON.parse(message.content as string)).toEqual({
      summary: "The player answered.",
      data: { answer: "yes" },
    });
  });
});

it("keeps signed provider state unchanged in tool-loop history", () => {
  const providerContinuation = {
    protocol: "anthropic-messages-v1",
    model: "fixture",
    items: [{ type: "thinking", thinking: "summary", signature: "opaque" }],
  };
  const message = buildAssistantToolCallMessage({
    content: null,
    toolCalls: [],
    providerContinuation,
  });
  expect(message.providerContinuation).toBe(providerContinuation);
});
