import { describe, expect, it } from "vitest";
import {
  queryDimensionSnapshot,
  type DimensionSnapshot,
} from "../src/dimensions.js";

const rowId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const snapshot: DimensionSnapshot = {
  ledger: {
    name: { en: "Ledger", "zh-CN": "账本" },
    schema: { type: "object" },
    value: {
      sessionId: "session-1",
      id: rowId,
      gold: 12,
      entries: [
        { item: "rope", updatedAt: "2026-10-16T08:00:00Z" },
        { item: "lamp", updatedAt: "2026-10-16T09:00:00Z" },
      ],
    },
    version: 3,
  },
};

describe("queryDimensionSnapshot", () => {
  it("keeps full results while the model text hides bookkeeping", () => {
    const answer = queryDimensionSnapshot(
      snapshot,
      { queries: [{ dimension: "ledger" }] },
      "en",
    );
    expect(answer.results[0]).toMatchObject({
      found: true,
      name: "Ledger",
      version: 3,
      value: { sessionId: "session-1", id: rowId },
    });
    expect(answer._text).toBe(
      'ledger (v3) = {"gold":12,"entries":[{"item":"rope"},{"item":"lamp"}]}',
    );
  });

  it.each(["sessionId", "id", "/entries/0/updatedAt"])(
    "a direct query of %s finds the value but no model text",
    (path) => {
      const answer = queryDimensionSnapshot(snapshot, {
        queries: [{ dimension: "ledger", path }],
      });
      expect(answer.results[0]).toMatchObject({ found: true });
      expect(answer._text).toBe(`ledger.${path}: not found`);
    },
  );

  it("pages the projected value for the model text", () => {
    const answer = queryDimensionSnapshot(snapshot, {
      queries: [{ dimension: "ledger", path: "entries", limit: 1 }],
    });
    expect(answer.results[0]).toMatchObject({
      page: {
        value: [{ item: "rope", updatedAt: "2026-10-16T08:00:00Z" }],
        total: 2,
        nextOffset: 1,
      },
    });
    expect(answer._text).toBe(
      'ledger.entries (v3) = {"value":[{"item":"rope"}],"total":2,"nextOffset":1}',
    );
  });

  it("reports an unknown dimension in both results and text", () => {
    const answer = queryDimensionSnapshot(snapshot, {
      queries: [{ dimension: "missing" }],
    });
    expect(answer.results[0]).toMatchObject({
      found: false,
      error: "Unknown dimension",
    });
    expect(answer._text).toBe("missing: not found");
  });
});
