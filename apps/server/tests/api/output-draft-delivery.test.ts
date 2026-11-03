import { describe, expect, it } from "vitest";
import type { OutputDraftEvent } from "@covel/runtime";
import { createOutputDraftDelivery } from "../../src/routes/api/output-draft-delivery.js";

const base = { turnId: "t", runtimeId: "p/story", pluginId: "p" };
const draft = (draftId: string, text: string): OutputDraftEvent => ({
  type: "output.draft",
  payload: { ...base, draftId, mode: "units", units: [{ text }] },
});

function setup() {
  const slots: Array<{ type: string; payload: () => unknown }> = [];
  const sink = createOutputDraftDelivery((type, payload) =>
    slots.push({ type, payload }),
  );
  /** Writes every reserved slot in order, as the queue would. */
  const flush = () =>
    slots.splice(0).flatMap(({ type, payload }) => {
      const value = payload() as { units?: { text: string }[] } | undefined;
      return value
        ? [`${type} ${value.units?.map((unit) => unit.text).join("|") ?? ""}`]
        : [];
    });
  return { sink, flush };
}

describe("createOutputDraftDelivery", () => {
  it("sends only the latest of the drafts waiting in the queue", () => {
    const { sink, flush } = setup();
    sink(draft("a", "One."));
    sink(draft("a", "One. Two."));
    sink(draft("a", "One. Two. Three."));
    expect(flush()).toEqual(["output.draft One. Two. Three."]);
    sink(draft("a", "Four."));
    expect(flush()).toEqual(["output.draft Four."]);
  });

  it("drops a waiting draft once it is retracted, keeping the order", () => {
    const { sink, flush } = setup();
    sink(draft("a", "Old."));
    sink({
      type: "output.retracted",
      payload: { ...base, draftId: "a", reason: "revising" },
    });
    sink(draft("b", "New."));
    sink({
      type: "output.accepted",
      payload: { ...base, draftId: "b", units: [{ text: "New." }] },
    });
    expect(flush()).toEqual(["output.retracted ", "output.accepted New."]);
  });
});
