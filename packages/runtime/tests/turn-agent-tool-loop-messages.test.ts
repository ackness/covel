import { describe, expect, it } from "vitest";
import {
  buildAssistantToolCallMessage,
  buildPreToolAbortMessage,
  buildToolExecutionUnavailableMessage,
  buildToolResultMessage,
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
        content: '{"ok":true}',
      }),
    ).toEqual({
      role: "tool",
      content: '{"ok":true}',
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
      error: "pre-tool-use hook aborted: tool blocked",
    });
  });

  it("builds the no-executor fallback tool message", () => {
    expect(buildToolExecutionUnavailableMessage("tc-missing")).toEqual({
      role: "tool",
      content: '{"result":"Tool execution not available"}',
      toolCallId: "tc-missing",
    });
  });
});
