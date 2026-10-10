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
    const content = { ok: true };
    const initial = Object.freeze(withPendingProposals(content, [proposal]));
    const result = withEmittedEvents(initial, [event]);
    expect(getToolContent(result)).toBe(content);
    expect(getPendingProposals(result)).toEqual([proposal]);
    expect(getEmittedEvents(result)).toEqual([event]);
  });

  it.each(["spread", "clone", "json"])(
    "preserves content and effects through %s copying",
    (copy) => {
      const original = withPendingProposals(
        withEmittedEvents({ saved: true }, [event]),
        [proposal],
      );
      const result =
        copy === "spread"
          ? { ...original }
          : copy === "clone"
            ? structuredClone(original)
            : JSON.parse(JSON.stringify(original));
      expect(getToolContent(result)).toEqual({ saved: true });
      expect(getPendingProposals(result)).toEqual([proposal]);
      expect(getEmittedEvents(result)).toEqual([event]);
    },
  );

  it("accepts a directly authored public envelope without private branding", () => {
    const result = {
      kind: "covel.tool-result" as const,
      content: "saved",
      pendingProposals: [proposal],
    };
    expect(getToolContent(result)).toBe("saved");
    expect(getPendingProposals(result)).toEqual([proposal]);
  });

  it("has one stable return shape even for empty effects and frozen content", () => {
    const content = Object.freeze({ ok: true });
    const result = withPendingProposals(content, []);
    expect(result).toEqual({
      kind: "covel.tool-result",
      content,
      pendingProposals: [],
    });
    expect(result.content).toBe(content);
    expect(Object.getOwnPropertySymbols(content)).toEqual([]);
  });

  it("does not mistake business fields for an effects envelope", () => {
    const content = { content: "user data", pendingProposals: [proposal] };
    expect(getToolContent<unknown>(content)).toBe(content);
    expect(getPendingProposals(content)).toEqual([]);
  });
});
