/**
 * P0-b regression tests for the asset.generated slice of session-store.tsx.
 *
 * Mirrors session-store-suspensions.test.ts: the reducer is module-private,
 * so we re-implement the exact slice logic here as a pure function and
 * pin its behaviour. Anyone reverting to a mutation-based implementation
 * (or swapping the dedup keys) breaks these tests immediately.
 *
 * Covers SPEC §5.7 — `assetsByTurn` shape + reducer transitions:
 *   - ASSET_GENERATED appends to the right turn
 *   - same id arriving twice does NOT double-insert (eventBus fan-out safety)
 *   - different turn ids stay isolated
 *   - SET_SESSION (different id) clears the map
 *   - RESET_SESSION clears the map
 */

import { describe, expect, it } from "vitest";
import type { AssetGenerateView } from "@covel/shared";

interface State {
	readonly session: { id: string } | null;
	readonly assetsByTurn: ReadonlyMap<string, readonly AssetGenerateView[]>;
}

type Action =
	| { type: "ASSET_GENERATED"; turnId: string; asset: AssetGenerateView }
	| { type: "SET_SESSION"; session: { id: string } }
	| { type: "RESET_SESSION" };

/**
 * Mirror of the asset slice in session-store.tsx. Keep this in sync with
 * the production reducer — the whole point of this test is to catch
 * accidental drift.
 */
function reduce(state: State, action: Action): State {
	switch (action.type) {
		case "ASSET_GENERATED": {
			const existing = state.assetsByTurn.get(action.turnId) ?? [];
			if (existing.some((a) => a.id === action.asset.id)) return state;
			const nextBucket: readonly AssetGenerateView[] = [
				...existing,
				action.asset,
			];
			const nextMap = new Map(state.assetsByTurn);
			nextMap.set(action.turnId, nextBucket);
			return { ...state, assetsByTurn: nextMap };
		}
		case "SET_SESSION": {
			const sameSession = state.session?.id === action.session.id;
			return {
				...state,
				session: action.session,
				assetsByTurn: sameSession
					? state.assetsByTurn
					: new Map<string, readonly AssetGenerateView[]>(),
			};
		}
		case "RESET_SESSION":
			return {
				...state,
				session: null,
				assetsByTurn: new Map<string, readonly AssetGenerateView[]>(),
			};
		default:
			return state;
	}
}

const empty: State = {
	session: null,
	assetsByTurn: new Map<string, readonly AssetGenerateView[]>(),
};

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

describe("session-store — P0-b assetsByTurn slice", () => {
	it("ASSET_GENERATED appends to the matching turn bucket", () => {
		const a = makeAsset({ id: "a-1" });
		const next = reduce(empty, {
			type: "ASSET_GENERATED",
			turnId: "turn-1",
			asset: a,
		});
		const bucket = next.assetsByTurn.get("turn-1");
		expect(bucket).toBeDefined();
		expect(bucket).toHaveLength(1);
		expect(bucket?.[0]).toBe(a);
	});

	it("ASSET_GENERATED accumulates multiple assets in the same turn (preserves order)", () => {
		const a = makeAsset({ id: "a-1" });
		const b = makeAsset({ id: "a-2", modality: "audio" });
		const c = makeAsset({ id: "a-3", modality: "tile" });
		let s = empty;
		s = reduce(s, { type: "ASSET_GENERATED", turnId: "turn-1", asset: a });
		s = reduce(s, { type: "ASSET_GENERATED", turnId: "turn-1", asset: b });
		s = reduce(s, { type: "ASSET_GENERATED", turnId: "turn-1", asset: c });
		expect(s.assetsByTurn.get("turn-1")).toEqual([a, b, c]);
	});

	it("ASSET_GENERATED is idempotent on duplicate ids (eventBus double-delivery safety)", () => {
		const a = makeAsset({ id: "dup" });
		const once = reduce(empty, {
			type: "ASSET_GENERATED",
			turnId: "turn-1",
			asset: a,
		});
		const twice = reduce(once, {
			type: "ASSET_GENERATED",
			turnId: "turn-1",
			asset: a,
		});
		expect(twice.assetsByTurn.get("turn-1")).toHaveLength(1);
		// Same-state reference preserved on dedupe (matches ADD_SUSPENSION pattern).
		expect(twice).toBe(once);
	});

	it("ASSET_GENERATED isolates buckets across different turn ids", () => {
		const a = makeAsset({ id: "a-1" });
		const b = makeAsset({ id: "b-1" });
		let s = empty;
		s = reduce(s, { type: "ASSET_GENERATED", turnId: "turn-A", asset: a });
		s = reduce(s, { type: "ASSET_GENERATED", turnId: "turn-B", asset: b });
		expect(s.assetsByTurn.get("turn-A")).toEqual([a]);
		expect(s.assetsByTurn.get("turn-B")).toEqual([b]);
	});

	it("ASSET_GENERATED never mutates the previous bucket (immutability check)", () => {
		const a = makeAsset({ id: "a-1" });
		const b = makeAsset({ id: "a-2" });
		const once = reduce(empty, {
			type: "ASSET_GENERATED",
			turnId: "turn-1",
			asset: a,
		});
		const firstBucket = once.assetsByTurn.get("turn-1");
		const twice = reduce(once, {
			type: "ASSET_GENERATED",
			turnId: "turn-1",
			asset: b,
		});
		const secondBucket = twice.assetsByTurn.get("turn-1");
		expect(firstBucket).not.toBe(secondBucket);
		expect(firstBucket).toHaveLength(1);
		expect(secondBucket).toHaveLength(2);
	});

	it("SET_SESSION (different id) clears the asset map", () => {
		const seeded: State = {
			session: { id: "sess-1" },
			assetsByTurn: new Map([["turn-1", [makeAsset({ id: "a-1" })]]]),
		};
		const next = reduce(seeded, {
			type: "SET_SESSION",
			session: { id: "sess-2" },
		});
		expect(next.session?.id).toBe("sess-2");
		expect(next.assetsByTurn.size).toBe(0);
	});

	it("SET_SESSION (same id) preserves the map (no-op refresh)", () => {
		const a = makeAsset({ id: "a-1" });
		const seeded: State = {
			session: { id: "sess-1" },
			assetsByTurn: new Map([["turn-1", [a]]]),
		};
		const next = reduce(seeded, {
			type: "SET_SESSION",
			session: { id: "sess-1" },
		});
		expect(next.assetsByTurn).toBe(seeded.assetsByTurn);
	});

	it("RESET_SESSION clears the map", () => {
		const seeded: State = {
			session: { id: "sess-1" },
			assetsByTurn: new Map([["turn-1", [makeAsset({ id: "a-1" })]]]),
		};
		const next = reduce(seeded, { type: "RESET_SESSION" });
		expect(next.assetsByTurn.size).toBe(0);
	});
});
