/**
 * Working Memory commit handler tests (S3-T3).
 *
 * Verifies that `working_memory.set` proposals flow through `commitAll`,
 * persist to store, and emit `working_memory.changed`. Also verifies the
 * flag-off path rejects proposals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Proposal } from "@covel/shared";
import {
	createCommitPipeline,
	type KernelStore,
} from "../src/session-kernel.js";

const SOURCE = { pluginId: "wm-test", runtimeId: "wm-test" };
const TURN_ID = "turn-wm";
const SESSION_ID = "sess-wm";

interface RecordingStore extends KernelStore {
	readonly wmEntries: Array<Record<string, unknown>>;
	readonly traceEvents: Array<Record<string, unknown>>;
}

function makeRecordingStore(): RecordingStore {
	const wmEntries: Array<Record<string, unknown>> = [];
	const traceEvents: Array<Record<string, unknown>> = [];

	return {
		wmEntries,
		traceEvents,

		async addMessage() {},
		async updateSession() {},
		async saveEvent() {},
		async addStateChange() {},
		async addTraceEvent(record) {
			traceEvents.push(record as Record<string, unknown>);
		},
		async upsertWorkingMemory(record) {
			wmEntries.push(record as Record<string, unknown>);
		},
	};
}

function makeWmProposal(overrides?: Partial<Proposal>): Proposal {
	return {
		id: crypto.randomUUID(),
		type: "working_memory.set",
		source: SOURCE,
		turnId: TURN_ID,
		sessionId: SESSION_ID,
		payload: {
			scope: "player",
			key: "testKey",
			value: { name: "hero" },
		},
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

describe("working_memory.set commit handler", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.COVEL_WORKING_MEMORY_V1;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		} else {
			process.env.COVEL_WORKING_MEMORY_V1 = originalEnv;
		}
	});

	describe("flag ON (COVEL_WORKING_MEMORY_V1=1)", () => {
		beforeEach(() => {
			process.env.COVEL_WORKING_MEMORY_V1 = "1";
		});

		it("persists the WM entry and returns committed=true", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal();

			const result = await pipeline.commit(proposal);

			expect(result.committed).toBe(true);
			expect(store.wmEntries).toHaveLength(1);
			expect(store.wmEntries[0]).toMatchObject({
				sessionId: SESSION_ID,
				key: "testKey",
				scope: "player",
				value: { name: "hero" },
			});
		});

		it("emits working_memory.changed event", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal();

			const result = await pipeline.commit(proposal);

			expect(result.committed).toBe(true);
			expect(result.event).toBeDefined();
			expect(result.event!.type).toBe("working_memory.changed");
			expect(result.event!.payload).toMatchObject({
				scope: "player",
				key: "testKey",
			});
		});

		it("flows through commitAll", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposals: Proposal[] = [makeWmProposal()];

			const results = await pipeline.commitAll(proposals);

			expect(results).toHaveLength(1);
			expect(results[0].committed).toBe(true);
			expect(store.wmEntries).toHaveLength(1);
		});

		it("rejects unknown scope", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal({
				payload: { scope: "invalid", key: "k", value: 1 },
			});

			const result = await pipeline.commit(proposal);
			expect(result.committed).toBe(false);
			expect(result.error).toContain("invalid scope");
		});

		it("rejects undefined value", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal({
				payload: { scope: "story", key: "k", value: undefined },
			});

			const result = await pipeline.commit(proposal);
			expect(result.committed).toBe(false);
			expect(result.error).toContain("undefined");
		});

		it("accepts null, 0, false, empty string as valid values", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);

			for (const value of [null, 0, false, ""]) {
				const result = await pipeline.commit(
					makeWmProposal({ payload: { scope: "shared", key: "v", value } }),
				);
				expect(result.committed).toBe(true);
			}
		});

		it("rejects non-string schemaRef", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal({
				payload: { scope: "player", key: "k", value: 1, schemaRef: 123 },
			});

			const result = await pipeline.commit(proposal);
			expect(result.committed).toBe(false);
			expect(result.error).toContain("schemaRef");
		});

		it("accepts a string schemaRef (opaque, no resolution)", async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal({
				payload: {
					scope: "player",
					key: "k",
					value: 1,
					schemaRef: "some-schema-name",
				},
			});

			const result = await pipeline.commit(proposal);
			expect(result.committed).toBe(true);
			expect(store.wmEntries[0]).toMatchObject({
				schemaRef: "some-schema-name",
			});
		});
	});

	describe("flag OFF (COVEL_WORKING_MEMORY_V1 unset)", () => {
		beforeEach(() => {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		});

		it('returns committed=false with error "working_memory disabled"', async () => {
			const store = makeRecordingStore();
			const pipeline = createCommitPipeline(store);
			const proposal = makeWmProposal();

			const result = await pipeline.commit(proposal);

			expect(result.committed).toBe(false);
			expect(result.error).toContain("working_memory disabled");
			expect(store.wmEntries).toHaveLength(0);
		});
	});
});
