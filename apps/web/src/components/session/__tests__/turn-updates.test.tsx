import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  isTurnUpdateMessage,
  TurnUpdates,
  turnUpdateTitle,
} from "../chat-messages/turn-updates.js";

function card(title: string, id = title): StreamMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: "2026-10-02T00:00:00.000Z",
    turnId: "turn-1",
    runtimeId: "codex",
    kind: "plugin",
    block: {
      id,
      type: "ui.render",
      data: {
        parts: [
          {
            id: "ui-1",
            type: "ui-spec",
            content: {
              spec: { type: "EntryCard", props: { title } },
              meta: { title },
            },
          },
        ],
      },
    },
  };
}

function block(type: string, data: Record<string, unknown> = {}) {
  return { ...card("x"), block: { id: "b", type, data } };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

describe("turn updates", () => {
  it("folds read-only plugin cards but never interactions or warnings", () => {
    expect(isTurnUpdateMessage(card("Lower Tide"))).toBe(true);
    expect(isTurnUpdateMessage(block("notification", { level: "info" }))).toBe(
      true,
    );
    expect(
      isTurnUpdateMessage(block("notification", { level: "warning" })),
    ).toBe(false);
    for (const type of [
      "interactive_form",
      "choice",
      "plugin_message",
      "asset.generate",
    ])
      expect(isTurnUpdateMessage(block(type))).toBe(false);
    expect(isTurnUpdateMessage({ ...card("story"), kind: "story" })).toBe(
      false,
    );
  });

  it("reads a public title from the card spec", () => {
    expect(turnUpdateTitle(card("Lower Tide"))).toBe("Lower Tide");
    expect(turnUpdateTitle(block("notification", { title: "Unlocked" }))).toBe(
      "Unlocked",
    );
    expect(turnUpdateTitle(block("ui.render"))).toBeUndefined();
  });

  it("starts folded with a count and title preview", () => {
    const messages = ["Iron Meg", "Grey House", "Stilltide", "Archive"].map(
      (title) => card(title),
    );
    render(
      <TurnUpdates messages={messages} defaultOpen={false}>
        <p>card body</p>
      </TurnUpdates>,
    );
    const details = screen.getByTestId("turn-updates") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Turn updates · 4Iron Meg · Grey House · Stilltide …",
    );
  });
});
