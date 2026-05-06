import { describe, it, expect, beforeEach } from "vitest";
import { createWriteCollector } from "../src/write-collector.js";
import type { WriteCollector, PendingWrite } from "../src/write-collector.js";

function makeWrite(overrides: Partial<PendingWrite> = {}): PendingWrite {
	return {
		table: "stats",
		field: "hp",
		newValue: 80,
		pluginId: "plugin-a",
		runtimeId: "runtime-a",
		priority: 500,
		...overrides,
	};
}

describe("WriteCollector", () => {
	let wc: WriteCollector;

	beforeEach(() => {
		wc = createWriteCollector();
	});

	describe("recordWrite + getPendingWrites", () => {
		it("should record writes and return them", () => {
			const w1 = makeWrite({ field: "hp" });
			const w2 = makeWrite({ field: "mp", newValue: 30 });
			wc.recordWrite(w1);
			wc.recordWrite(w2);

			const pending = wc.getPendingWrites();
			expect(pending).toHaveLength(2);
			expect(pending[0]).toEqual(w1);
			expect(pending[1]).toEqual(w2);
		});
	});

	describe("commit: no conflicts", () => {
		it("should commit all writes when targeting different fields", () => {
			wc.recordWrite(
				makeWrite({
					field: "hp",
					newValue: 80,
					pluginId: "a",
					runtimeId: "ra",
				}),
			);
			wc.recordWrite(
				makeWrite({
					field: "mp",
					newValue: 30,
					pluginId: "b",
					runtimeId: "rb",
				}),
			);

			const result = wc.commit();
			expect(result.committed).toHaveLength(2);
			expect(result.conflicts).toHaveLength(0);
		});
	});

	describe("commit: conflict detected", () => {
		it("should detect conflict when two writes target same field with different values", () => {
			wc.recordWrite(
				makeWrite({
					field: "hp",
					newValue: 80,
					pluginId: "a",
					runtimeId: "ra",
					priority: 500,
				}),
			);
			wc.recordWrite(
				makeWrite({
					field: "hp",
					newValue: 60,
					pluginId: "b",
					runtimeId: "rb",
					priority: 400,
				}),
			);

			const result = wc.commit();
			expect(result.committed).toHaveLength(0);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]!.table).toBe("stats");
			expect(result.conflicts[0]!.field).toBe("hp");
			expect(result.conflicts[0]!.writes).toHaveLength(2);
		});
	});

	describe("commit: same value = no conflict", () => {
		it("should merge writes with identical values without conflict", () => {
			wc.recordWrite(
				makeWrite({
					field: "hp",
					newValue: 80,
					pluginId: "a",
					runtimeId: "ra",
				}),
			);
			wc.recordWrite(
				makeWrite({
					field: "hp",
					newValue: 80,
					pluginId: "b",
					runtimeId: "rb",
				}),
			);

			const result = wc.commit();
			expect(result.committed).toHaveLength(1); // deduplicated
			expect(result.conflicts).toHaveLength(0);
		});
	});

	describe("clear", () => {
		it("should clear all pending writes", () => {
			wc.recordWrite(makeWrite());
			wc.recordWrite(makeWrite({ field: "mp" }));
			wc.clear();

			expect(wc.getPendingWrites()).toHaveLength(0);
		});
	});

	describe("commit result structure", () => {
		it("should have correct committed and conflicts arrays", () => {
			wc.recordWrite(
				makeWrite({
					table: "stats",
					field: "hp",
					newValue: 80,
					pluginId: "a",
					runtimeId: "ra",
				}),
			);
			wc.recordWrite(
				makeWrite({
					table: "stats",
					field: "hp",
					newValue: 60,
					pluginId: "b",
					runtimeId: "rb",
				}),
			);
			wc.recordWrite(
				makeWrite({
					table: "stats",
					field: "mp",
					newValue: 30,
					pluginId: "c",
					runtimeId: "rc",
				}),
			);

			const result = wc.commit();
			expect(result.committed).toHaveLength(1);
			expect(result.committed[0]!.field).toBe("mp");
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]!.field).toBe("hp");
		});
	});

	describe("conflict includes all write details", () => {
		it("should include originalValue, table, field, and all writes in WriteConflict", () => {
			wc.recordWrite(
				makeWrite({
					table: "inventory",
					field: "gold",
					newValue: 100,
					pluginId: "quest",
					runtimeId: "rt-quest",
					priority: 600,
					reason: "quest reward",
				}),
			);
			wc.recordWrite(
				makeWrite({
					table: "inventory",
					field: "gold",
					newValue: 50,
					pluginId: "shop",
					runtimeId: "rt-shop",
					priority: 500,
					reason: "purchase",
				}),
			);

			const result = wc.commit();
			expect(result.conflicts).toHaveLength(1);

			const conflict = result.conflicts[0]!;
			expect(conflict.table).toBe("inventory");
			expect(conflict.field).toBe("gold");
			expect(conflict.originalValue).toBeUndefined();
			expect(conflict.writes).toHaveLength(2);

			const writeEntries = conflict.writes;
			expect(writeEntries[0]).toEqual({
				runtimeId: "rt-quest",
				pluginId: "quest",
				priority: 600,
				newValue: 100,
				reason: "quest reward",
			});
			expect(writeEntries[1]).toEqual({
				runtimeId: "rt-shop",
				pluginId: "shop",
				priority: 500,
				newValue: 50,
				reason: "purchase",
			});
		});
	});
});
