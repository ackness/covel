// @vitest-environment node
import { expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";

it("restores existing field history into game state", () => {
  const patch = { id: "cached", summary: "stats", packageName: "probe" };
  const state = reducer(initialState, {
    type: "MERGE_INITIAL_STATE_PATCHES",
    patches: [
      { ...patch, data: { stats: { hp: 1 } } },
      { ...patch, data: { stats: { mp: 3 } } },
    ],
  });
  expect(state.gameState).toEqual({ tables: { stats: { hp: 1, mp: 3 } } });
  expect(state.statePatches).toHaveLength(2);
});

it("bounds retained history without discarding the authoritative snapshot", () => {
  const state = reducer(
    {
      ...initialState,
      hasGameStateSnapshot: true,
      gameState: { tables: { stats: { hp: 9 } } },
    },
    {
      type: "MERGE_INITIAL_STATE_PATCHES",
      patches: Array.from({ length: 1000 }, (_, i) => ({
        id: `cached-${i}`,
        summary: `stats.field-${i}`,
        packageName: "probe",
        data: { stats: { [`field-${i}`]: i } },
      })),
    },
  );
  expect(state.statePatches.length).toBeLessThanOrEqual(256);
  expect(state.recentStatePatchIds.length).toBeLessThanOrEqual(256);
  expect(state.gameState).toEqual({ tables: { stats: { hp: 9 } } });
});
