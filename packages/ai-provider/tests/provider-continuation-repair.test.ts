import { describe, expect, it } from "vitest";
import { continuationItems } from "../src/adapters/provider-continuation.js";
import type { TextMessage } from "../src/types.js";

describe("canonical tool calls in native continuation", () => {
  it.each(["openai-responses-v1", "anthropic-messages-v1"] as const)(
    "replays repaired and hook-rewritten arguments for %s while retaining opaque reasoning",
    (protocol) => {
      const reasoning =
        protocol === "openai-responses-v1"
          ? { type: "reasoning", encrypted_content: "opaque" }
          : { type: "thinking", thinking: "reasoning", signature: "signed" };
      const original =
        protocol === "openai-responses-v1"
          ? {
              type: "function_call",
              id: "fc-1",
              call_id: "tc-1",
              name: "original",
              arguments: '{"note":"fixed"}]}',
            }
          : {
              type: "tool_use",
              id: "tc-1",
              name: "original",
              input: { note: "old" },
            };
      const message: TextMessage = {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc-1", name: "rewritten", arguments: '{"note":"fixed"}' },
        ],
        providerContinuation: {
          protocol,
          model: "fixture",
          items: [reasoning, original],
        },
      };
      const items = continuationItems(message, protocol, "fixture", {});
      expect(items?.[0]).toEqual(reasoning);
      expect(items?.[1]).toEqual(
        protocol === "openai-responses-v1"
          ? { ...original, name: "rewritten", arguments: '{"note":"fixed"}' }
          : { ...original, name: "rewritten", input: { note: "fixed" } },
      );
      expect(message.providerContinuation?.items[1]).toEqual(original);
    },
  );
});
