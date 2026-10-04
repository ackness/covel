// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import { initialState, reducer } from "../session-store/reducer.js";

describe("session-store generated worlds", () => {
  it("replaces a regenerated world without duplicating it or merging its old fields", () => {
    const original: WorldRecord = {
      id: "harbor",
      name: "Harbor",
      description: "Old draft",
      lore: "Obsolete lore",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    };
    const neighbor = { ...original, id: "another-harbor" };
    const replacement: WorldRecord = {
      id: original.id,
      name: "New Harbor",
      description: "New draft",
      createdAt: "2026-10-04T01:00:00.000Z",
      updatedAt: "2026-10-04T01:00:00.000Z",
    };
    const state = { ...initialState, worlds: [original, neighbor] };
    const updated = reducer(state, { type: "ADD_WORLD", world: replacement });
    const repeated = reducer(updated, {
      type: "ADD_WORLD",
      world: replacement,
    });

    expect(repeated.worlds).toEqual([replacement, neighbor]);
    expect(state.worlds).toEqual([original, neighbor]);

    const distinct = { ...replacement, id: "new-harbor" };
    expect(
      reducer(repeated, { type: "ADD_WORLD", world: distinct }).worlds,
    ).toEqual([replacement, neighbor, distinct]);
  });
});
