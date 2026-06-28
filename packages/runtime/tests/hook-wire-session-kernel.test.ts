/**
 * Hook wire-in tests for session-kernel (S4-T3).
 *
 * Covers:
 * - PreStateCommit abort skips the proposal but commits the rest
 * - PostStateCommit fires after successful commit (log-only, no abort)
 * - Flag-off path: zero effect on commit behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Proposal } from "@covel/shared";
import { createEventBus } from "@covel/events";
import {
  createCommitPipeline,
  type KernelStore,
} from "../src/session/session-kernel.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

// ── Store factory ─────────────────────────────────────────────────

interface RecordingStore extends KernelStore {
  readonly messages: Array<Record<string, unknown>>;
  readonly stateChanges: Array<Record<string, unknown>>;
  readonly pluginData: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
  readonly traceEvents: Array<Record<string, unknown>>;
}

function createRecordingStore(): RecordingStore {
  const messages: Array<Record<string, unknown>> = [];
  const stateChanges: Array<Record<string, unknown>> = [];
  const pluginData: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const traceEvents: Array<Record<string, unknown>> = [];

  return {
    messages,
    stateChanges,
    pluginData,
    events,
    traceEvents,
    async addMessage(r) {
      messages.push(r as Record<string, unknown>);
    },
    async updateSession() {},
    async saveEvent(r) {
      events.push(r as Record<string, unknown>);
    },
    async addStateChange(r) {
      stateChanges.push(r as Record<string, unknown>);
    },
    async setPluginData(r) {
      pluginData.push(r as Record<string, unknown>);
    },
    async addTraceEvent(r) {
      traceEvents.push(r as Record<string, unknown>);
    },
  };
}

// ── Proposal factory ──────────────────────────────────────────────

function makeProposal(
  type: Proposal["type"],
  payload: Record<string, unknown>,
  suffix: string,
): Proposal {
  return {
    id: `prop-${suffix}`,
    type,
    source: { pluginId: "test-plugin", runtimeId: "test-plugin" },
    turnId: "turn-kernel-hooks",
    sessionId: "sess-kernel-hooks",
    payload,
    timestamp: new Date().toISOString(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("session-kernel hook wire-in", () => {
  describe("No-pipeline path", () => {
    it("commits normally without hookPipeline — no side effects", async () => {
      const store = createRecordingStore();
      const pipeline = createCommitPipeline(store);
      const proposals = [
        makeProposal(
          "narrative.append",
          { content: "hello", kind: "story" },
          "a",
        ),
        makeProposal(
          "state.patch",
          { table: "stats", field: "hp", value: 50 },
          "b",
        ),
      ];
      const results = await pipeline.commitAll(proposals);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.committed)).toBe(true);
      expect(store.messages).toHaveLength(1);
      expect(store.stateChanges).toHaveLength(1);
    });
  });

  describe("PreStateCommit hook", () => {
    it("skips proposal when PreStateCommit aborts, commits the rest", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();

      // Abort the state.patch proposal only
      hookPipeline.register({
        id: "test:PreStateCommit:0",
        event: "PreStateCommit",
        handler: vi
          .fn()
          .mockImplementation(
            async (_ctx, payload: { proposal: { type: string } }) => {
              if (payload.proposal.type === "state.patch") {
                return { action: "abort", reason: "state patch blocked" };
              }
              return { action: "continue" };
            },
          ),
      });

      const pipeline = createCommitPipeline(store, hookPipeline);
      const proposals = [
        makeProposal("narrative.append", { content: "ok", kind: "story" }, "a"),
        makeProposal(
          "state.patch",
          { table: "stats", field: "hp", value: 50 },
          "b",
        ),
        makeProposal(
          "narrative.append",
          { content: "also ok", kind: "story" },
          "c",
        ),
      ];

      const results = await pipeline.commitAll(proposals);

      // First and third committed; second was aborted
      expect(results[0].committed).toBe(true);
      expect(results[1].committed).toBe(false);
      expect(results[1].error).toContain("pre-state-commit hook aborted");
      expect(results[2].committed).toBe(true);

      // Only the narrative messages were written
      expect(store.messages).toHaveLength(2);
      expect(store.stateChanges).toHaveLength(0);
    });

    it("continue path: all proposals commit normally", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();

      hookPipeline.register({
        id: "test:PreStateCommit:0",
        event: "PreStateCommit",
        handler: vi.fn().mockResolvedValue({ action: "continue" }),
      });

      const pipeline = createCommitPipeline(store, hookPipeline);
      const proposals = [
        makeProposal("narrative.append", { content: "ok", kind: "story" }, "a"),
        makeProposal(
          "state.patch",
          { table: "stats", field: "hp", value: 50 },
          "b",
        ),
      ];

      const results = await pipeline.commitAll(proposals);
      expect(results.every((r) => r.committed)).toBe(true);
      expect(store.messages).toHaveLength(1);
      expect(store.stateChanges).toHaveLength(1);
    });

    it("blocks plugin.data proposals before they reach the store", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();

      hookPipeline.register({
        id: "test:PreStateCommit:block-plugin-data",
        event: "PreStateCommit",
        handler: vi
          .fn()
          .mockImplementation(
            async (_ctx, payload: { proposal: { type: string } }) => {
              if (payload.proposal.type === "plugin.data") {
                return { action: "abort", reason: "plugin data blocked" };
              }
              return { action: "continue" };
            },
          ),
      });

      const pipeline = createCommitPipeline(store, hookPipeline);
      const result = await pipeline.commit(
        makeProposal(
          "plugin.data",
          {
            namespace: "entries",
            key: "codex-qingping",
            value: { title: "青萍山" },
          },
          "plugin-data",
        ),
      );

      expect(result.committed).toBe(false);
      expect(result.error).toContain("plugin data blocked");
      expect(store.pluginData).toHaveLength(0);
    });
  });

  describe("PostStateCommit hook", () => {
    it("fires after successful commit with the proposal and result", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();

      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      hookPipeline.register({
        id: "test:PostStateCommit:0",
        event: "PostStateCommit",
        handler,
      });

      const pipeline = createCommitPipeline(store, hookPipeline);
      await pipeline.commit(
        makeProposal(
          "narrative.append",
          { content: "hello", kind: "story" },
          "p",
        ),
      );

      expect(handler).toHaveBeenCalledOnce();
      const [_ctx, payload] = handler.mock.calls[0] as [
        unknown,
        { proposal: Proposal; result: { committed: boolean } },
      ];
      expect(payload.proposal.type).toBe("narrative.append");
      expect(payload.result.committed).toBe(true);
    });

    it("abort from PostStateCommit does not undo the commit", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();

      hookPipeline.register({
        id: "test:PostStateCommit:0",
        event: "PostStateCommit",
        handler: vi
          .fn()
          .mockResolvedValue({ action: "abort", reason: "audit failed" }),
      });

      const pipeline = createCommitPipeline(store, hookPipeline);
      const result = await pipeline.commit(
        makeProposal(
          "narrative.append",
          { content: "written", kind: "story" },
          "q",
        ),
      );

      // Proposal was committed despite post-hook abort
      expect(result.committed).toBe(true);
      expect(store.messages).toHaveLength(1);
    });
  });

  describe("EventBus observability (F5)", () => {
    it("emits hook.error to eventBus when a PreStateCommit hook throws", async () => {
      const store = createRecordingStore();
      const hookPipeline = createHookPipeline();
      const eventBus = createEventBus();

      const emittedTypes: string[] = [];
      eventBus.onEmit((e) => {
        emittedTypes.push(e.type);
      });

      hookPipeline.register({
        id: "test:PreStateCommit:throw",
        event: "PreStateCommit",
        handler: vi.fn().mockRejectedValue(new Error("validation exploded")),
      });

      const pipeline = createCommitPipeline(store, hookPipeline, eventBus);
      const result = await pipeline.commit(
        makeProposal(
          "narrative.append",
          { content: "test", kind: "story" },
          "err",
        ),
      );

      // The commit was aborted (hook threw)
      expect(result.committed).toBe(false);
      expect(result.error).toContain("validation exploded");

      // The eventBus received a hook.error event
      expect(emittedTypes).toContain("hook.error");
    });
  });
});
