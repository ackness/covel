/**
 * P0-b regression tests for the asset slices of session-store.tsx.
 *
 * Runs the production reducer directly so these tests protect the actual
 * session-store transition, rather than a copied implementation.
 *
 * Covers SPEC §5.7 — `assetsByTurn` / `assetProgressByTurn` transitions:
 *   - ASSET_GENERATED appends to the right turn
 *   - same id arriving twice does NOT double-insert (eventBus fan-out safety)
 *   - different turn ids stay isolated
 *   - ASSET_PROGRESS keeps ordered, turn-scoped progress history
 *   - SET_SESSION (different id) clears the map
 *   - RESET_SESSION clears the map
 */

import { describe, expect, it } from "vitest";
import type { AssetGenerateView } from "@covel/shared";
import type { SessionRecord } from "@/services/api";
import { initialState, reducer } from "../session-store/reducer.js";
import type { AssetProgressEvent } from "../session-store/types.js";

const session = (id: string) => ({ id }) as SessionRecord;

function makeAsset(
  overrides: Partial<AssetGenerateView> = {},
): AssetGenerateView {
  return {
    id: "prop-1",
    type: "asset.generate",
    sessionId: "sess-1",
    turnId: "turn-1",
    source: { pluginId: "image", runtimeId: "image/runner" },
    ref: {
      id: "a".repeat(64),
      mime: "image/png",
      size: 16,
      url: "https://cdn/x.png",
    },
    modality: "image",
    createdAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeProgress(
  overrides: Partial<AssetProgressEvent> = {},
): AssetProgressEvent {
  return {
    assetId: "a-1",
    phase: "generating",
    percent: 50,
    timestamp: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("session-store — P0-b assetsByTurn slice", () => {
  it("keeps generated assets ordered, turn-scoped, deduped, and observable by immutable consumers", () => {
    const a = makeAsset({ id: "a-1" });
    const b = makeAsset({ id: "a-2", modality: "audio" });
    const otherTurn = makeAsset({ id: "b-1", turnId: "turn-2" });
    const once = reducer(initialState, {
      type: "ASSET_GENERATED",
      turnId: "turn-1",
      asset: a,
    });
    const firstBucket = once.assetsByTurn.get("turn-1");
    const duplicate = reducer(once, {
      type: "ASSET_GENERATED",
      turnId: "turn-1",
      asset: a,
    });
    const twice = reducer(duplicate, {
      type: "ASSET_GENERATED",
      turnId: "turn-1",
      asset: b,
    });
    const final = reducer(twice, {
      type: "ASSET_GENERATED",
      turnId: "turn-2",
      asset: otherTurn,
    });

    // Duplicate bus delivery is a no-op; a real append creates a new bucket so
    // memoised UI consumers observe it without mutating their previous view.
    expect(duplicate).toBe(once);
    expect(firstBucket).toEqual([a]);
    expect(twice.assetsByTurn.get("turn-1")).not.toBe(firstBucket);
    expect(final.assetsByTurn.get("turn-1")).toEqual([a, b]);
    expect(final.assetsByTurn.get("turn-2")).toEqual([otherTurn]);
  });

  it("keeps progress ordered within a turn and isolated across turns", () => {
    const queued = makeProgress({ phase: "queued", percent: 0 });
    const generating = makeProgress({ phase: "generating", percent: 50 });
    const otherTurn = makeProgress({ phase: "complete", percent: 100 });
    let state = reducer(initialState, {
      type: "ASSET_PROGRESS",
      turnId: "turn-1",
      progress: queued,
    });
    state = reducer(state, {
      type: "ASSET_PROGRESS",
      turnId: "turn-1",
      progress: generating,
    });
    state = reducer(state, {
      type: "ASSET_PROGRESS",
      turnId: "turn-2",
      progress: otherTurn,
    });

    expect(state.assetProgressByTurn.get("turn-1")).toEqual([
      queued,
      generating,
    ]);
    expect(state.assetProgressByTurn.get("turn-2")).toEqual([otherTurn]);
  });

  it("preserves assets on same-session refresh and clears them on every session boundary", () => {
    const seeded = {
      ...initialState,
      session: session("sess-1"),
      assetsByTurn: new Map([["turn-1", [makeAsset({ id: "a-1" })]]]),
      assetProgressByTurn: new Map([
        ["turn-1", [makeProgress({ phase: "queued" })]],
      ]),
    };
    const refreshed = reducer(seeded, {
      type: "SET_SESSION",
      session: session("sess-1"),
    });
    const switched = reducer(seeded, {
      type: "SET_SESSION",
      session: session("sess-2"),
    });
    const reset = reducer(seeded, { type: "RESET_SESSION" });

    expect(refreshed.assetsByTurn).toBe(seeded.assetsByTurn);
    expect(refreshed.assetProgressByTurn).toBe(seeded.assetProgressByTurn);
    for (const state of [switched, reset]) {
      expect(state.assetsByTurn.size).toBe(0);
      expect(state.assetProgressByTurn.size).toBe(0);
    }
  });
});
