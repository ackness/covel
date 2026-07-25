import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import { isPendingInteractionMessage } from "../game-view/interaction-blocks.js";

const baseMessage = (overrides: Partial<StreamMessage>): StreamMessage => ({
  id: "msg-1",
  role: "assistant",
  content: "",
  timestamp: "2026-05-09T00:00:00.000Z",
  ...overrides,
});

describe("game-view interaction block detection", () => {
  it("detects an unsubmitted legacy form block as pending", () => {
    const messages = [
      baseMessage({
        block: {
          type: "interactive_form",
          data: { fields: [{ name: "name", type: "text" }] },
        },
      }),
    ];

    expect(isPendingInteractionMessage(messages[0], messages, new Set())).toBe(
      true,
    );
  });

  it("ignores interactive blocks once a later user message exists", () => {
    const messages = [
      baseMessage({
        block: { type: "interactive_choice", data: { type: "choice" } },
      }),
      baseMessage({
        id: "msg-2",
        role: "user",
        content: "continue",
      }),
    ];

    expect(isPendingInteractionMessage(messages[0], messages, new Set())).toBe(
      false,
    );
  });

  it("detects plugin message specs that require an answer", () => {
    const messages = [
      baseMessage({
        block: {
          type: "plugin_message",
          data: {
            specs: [
              {
                component: "Button",
                props: { onClick: { action: "submitForm" } },
              },
            ],
          },
        },
      }),
    ];

    expect(isPendingInteractionMessage(messages[0], messages, new Set())).toBe(
      true,
    );
  });

  it("does not treat suggestion-only plugin panels as pending", () => {
    const messages = [
      baseMessage({
        block: {
          type: "plugin_message",
          data: {
            specs: [
              {
                component: "Button",
                props: { onClick: { action: "draftMessage" } },
              },
              {
                component: "Button",
                props: { onClick: { action: "selectSuggestion" } },
              },
            ],
          },
        },
      }),
    ];

    expect(isPendingInteractionMessage(messages[0], messages, new Set())).toBe(
      false,
    );
  });
});
