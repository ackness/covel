// @vitest-environment node
import { expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";

it("keeps only the latest field value while every change refreshes the panel", () => {
  let state = initialState;
  for (let i = 0; i < 1000; i++) {
    state = reducer(state, {
      type: "ADD_STATE_PATCH",
      patch: {
        id: `event-${i}`,
        summary: "stats.hp",
        packageName: "probe",
        data: { stats: { hp: i } },
      },
    });
  }
  expect(state.statePatches).toHaveLength(1);
  expect(state.statePatchRevision).toBe(1000);
  expect(state.gameState).toEqual({ stats: { hp: 999 } });
  const duplicate = reducer(state, {
    type: "ADD_STATE_PATCH",
    patch: {
      id: "event-998",
      summary: "stats.hp",
      packageName: "probe",
      data: { stats: { hp: 998 } },
    },
  });
  expect(duplicate).toBe(state);
});

it("bounds retained fields and event identities without discarding current game state", () => {
  let state = initialState;
  for (let i = 0; i < 1000; i++) {
    state = reducer(state, {
      type: "ADD_STATE_PATCH",
      patch: {
        id: `event-${i}`,
        summary: `stats.field-${i}`,
        packageName: "probe",
        data: { stats: { [`field-${i}`]: i } },
      },
    });
  }
  expect(state.statePatches.length).toBeLessThanOrEqual(256);
  expect(state.recentStatePatchIds.length).toBeLessThanOrEqual(256);
  expect(state.gameState.stats).toHaveProperty("field-0", 0);
  expect(state.statePatches.at(-1)?.data).toEqual({
    stats: { "field-999": 999 },
  });
});

it("restores all compacted fields from the same event and keeps a live value", () => {
  const patch = { id: "cached", summary: "stats", packageName: "probe" };
  let state = reducer(initialState, {
    type: "ADD_STATE_PATCH",
    patch: {
      ...patch,
      id: "live",
      data: { stats: { hp: 9 } },
    },
  });
  state = reducer(state, {
    type: "MERGE_INITIAL_STATE_PATCHES",
    patches: [
      { ...patch, data: { stats: { hp: 1 } } },
      { ...patch, data: { stats: { mp: 3 } } },
    ],
  });
  expect(state.gameState).toEqual({ stats: { hp: 9, mp: 3 } });
  expect(state.statePatches).toHaveLength(2);
});
