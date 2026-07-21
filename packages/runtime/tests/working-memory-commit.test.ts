/**
 * Working Memory commit handler tests.
 *
 * Verifies that `working_memory.set` proposals flow through `commitAll`,
 * persist to store, and emit `working_memory.changed`.
 */

import { describe, it, expect, vi } from "vitest";
import type { Proposal } from "@covel/shared";
import {
  createCommitPipeline,
  type KernelStore,
} from "../src/session/session-kernel.js";

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
    async listWorkingMemory() {
      return wmEntries.map((e) => ({
        key: e.key as string,
        scope: e.scope as "player" | "story" | "shared",
      }));
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
  describe("commit", () => {
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
});

describe("working_memory storage quota", () => {
  it("refuses new keys past the entry cap and oversized values, but still updates existing keys", async () => {
    const store = makeRecordingStore();
    const pipeline = createCommitPipeline(store);

    for (let i = 0; i < 200; i++) {
      const result = await pipeline.commit(
        makeWmProposal({
          payload: { scope: "player", key: `k${i}`, value: i },
        }),
      );
      expect(result.committed).toBe(true);
    }

    const overflow = await pipeline.commit(
      makeWmProposal({
        payload: { scope: "player", key: "k200", value: 1 },
      }),
    );
    expect(overflow.committed).toBe(false);
    expect(overflow.error).toContain("limit");

    // Updating an entry the session already relies on stays allowed.
    const update = await pipeline.commit(
      makeWmProposal({ payload: { scope: "player", key: "k0", value: 42 } }),
    );
    expect(update.committed).toBe(true);

    const oversized = await pipeline.commit(
      makeWmProposal({
        payload: { scope: "player", key: "k0", value: "x".repeat(9000) },
      }),
    );
    expect(oversized.committed).toBe(false);
    expect(oversized.error).toContain("char limit");
  });
});
