import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JSONUIProvider } from "@json-render/react";
import { covelRegistry } from "../catalog.js";
import type { PendingInteractionDraft } from "../interaction-selection.js";

const session = vi.hoisted(() => ({
  drafts: [] as PendingInteractionDraft[],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { pendingInteractionDrafts: session.drafts } }),
}));

beforeEach(() => {
  session.drafts = [];
});
afterEach(cleanup);

const draftClick = {
  action: "draftMessage",
  params: { text: "Ask about the ledger", selectionGroup: "guide:1" },
};

function renderChoice(props: Record<string, unknown>, emit = vi.fn()) {
  const Choice = covelRegistry.Choice;
  render(
    <JSONUIProvider registry={covelRegistry}>
      <Choice
        element={{ type: "Choice", props, on: { click: draftClick } }}
        emit={emit}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
      />
    </JSONUIProvider>,
  );
  return emit;
}

describe("Choice", () => {
  it("renders an option as one button and emits its click", () => {
    const emit = renderChoice({
      title: "Ask about the ledger",
      description: "She may not answer.",
      tag: "Talk",
      tone: "info",
    });
    const button = screen.getByRole("button");
    expect(button.className).toBe("ui-choice");
    expect(button.getAttribute("data-tone")).toBe("info");
    expect(button.getAttribute("aria-pressed")).toBeNull();
    expect(button.textContent).toContain("Ask about the ledger");
    expect(button.textContent).toContain("She may not answer.");
    expect(button.textContent).toContain("Talk");
    // The position marker is drawn by the theme, so it carries no text.
    expect(button.querySelector(".ui-choice-index")?.textContent).toBe("");
    fireEvent.click(button);
    expect(emit).toHaveBeenCalledWith("click");
  });

  it("echoes the pick while its draft is still queued", () => {
    session.drafts = [
      { selectionGroup: "guide:1", label: "Ask about the ledger" },
    ];
    renderChoice({ title: "Ask about the ledger" });
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-selected")).toBe("true");
  });

  it("renders nothing for an option without a title", () => {
    renderChoice({ title: "", tag: "Talk" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
