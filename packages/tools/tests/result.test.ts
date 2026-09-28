import { describe, expect, it } from "vitest";
import type { Proposal } from "@covel/shared";
import {
  withPendingProposals,
  withEmittedEvents,
  getPendingProposals,
  getEmittedEvents,
  getToolContent,
} from "../src/result.js";

const proposal: Proposal = {
  id: "proposal",
  type: "plugin.data",
  sessionId: "session",
  turnId: "turn",
  source: { pluginId: "plugin", runtimeId: "runtime" },
  timestamp: "2026-09-28T00:00:00.000Z",
  payload: { namespace: "test", key: "key", value: 1 },
};
const event = { topic: "changed", data: { value: 1 } };

describe("tool result composition", () => {
  it.each(["scalar", "frozen", "sealed", "mutable"])(
    "retains both channels for %s content in either order",
    (kind) => {
      for (const reverse of [false, true]) {
        const content =
          kind === "scalar"
            ? "ok"
            : kind === "frozen"
              ? Object.freeze({ ok: true })
              : kind === "sealed"
                ? Object.seal({ ok: true })
                : { ok: true };
        const result = reverse
          ? withPendingProposals(withEmittedEvents(content, [event]), [
              proposal,
            ])
          : withEmittedEvents(withPendingProposals(content, [proposal]), [
              event,
            ]);
        expect(getToolContent(result)).toBe(content);
        expect(getPendingProposals(result)).toEqual([proposal]);
        expect(getEmittedEvents(result)).toEqual([event]);
      }
    },
  );

  it("preserves attached effects when a carrier is frozen between wrappers", () => {
    const content = withPendingProposals({ ok: true }, [proposal]);
    Object.freeze(content);
    const result = withEmittedEvents(content, [event]);
    expect(getToolContent(result)).toBe(content);
    expect(getPendingProposals(result)).toEqual([proposal]);
    expect(getEmittedEvents(result)).toEqual([event]);
  });
});
