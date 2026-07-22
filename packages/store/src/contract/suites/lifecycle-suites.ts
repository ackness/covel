/**
 * Contract suites for the scheduling-redesign storage wave:
 *   - Session lifecycle fields (`phase` / `completedPlayerTurns` / `setupRuntimes`).
 *   - Logical-turn completion ledger (idempotent, count-at-most-once).
 *   - Setup-runtime attempt log (idempotent insert + terminalising update).
 *   - Append-only job-status stream (idempotent, ordered).
 *   - Snapshot payload V3 round-trip.
 *
 * Every backend runs this shared suite, so any SQLite/PG/Memory/IDB divergence
 * fails CI — backend parity is a hard contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore, SnapshotPayloadV3 } from "../../types.js";
import {
  makeJobStatus,
  makeLogicalTurnCompletion,
  makeSession,
  makeSetupAttempt,
  makeSnapshot,
  makeSnapshotPayloadV3,
  ts,
} from "../test-fixtures.js";

export function registerLifecycleStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("Session lifecycle fields", () => {
    it("persists phase / completedPlayerTurns / setupRuntimes on create", async () => {
      const session = makeSession({
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {
          "setup/schema": {
            state: "pending",
            pluginVersion: "1.0.0",
            generation: 1,
            attempts: 0,
          },
        },
      });
      await store.createSession(session);
      const created = await store.getSession(session.id);
      expect(created?.phase).toBe("setup");
      expect(created?.completedPlayerTurns).toBe(0);
      expect(created?.setupRuntimes).toEqual({
        "setup/schema": {
          state: "pending",
          pluginVersion: "1.0.0",
          generation: 1,
          attempts: 0,
        },
      });
    });

    it("updates lifecycle fields via updateSession", async () => {
      const session = makeSession();
      await store.createSession(session);
      await store.updateSession(session.id, {
        phase: "playing",
        completedPlayerTurns: 4,
        setupRuntimes: {
          "setup/schema": {
            state: "done",
            resolution: "completed",
            generation: 1,
            attempts: 1,
            completedAt: ts(),
            pluginVersion: "1.0.0",
          },
        },
        updatedAt: ts(),
      });
      const updated = await store.getSession(session.id);
      expect(updated?.phase).toBe("playing");
      expect(updated?.completedPlayerTurns).toBe(4);
      expect(updated?.setupRuntimes?.["setup/schema"]?.state).toBe("done");
    });

    it("reads a session written without lifecycle fields as absent", async () => {
      // Legacy-row parity: a session created without the new fields must read
      // back with them absent on every backend (no null resurrected).
      const session = makeSession();
      await store.createSession(session);
      const created = await store.getSession(session.id);
      expect(created?.phase).toBeUndefined();
      expect(created?.completedPlayerTurns).toBeUndefined();
      expect(created?.setupRuntimes).toBeUndefined();
    });

    it("replaces setupRuntimes wholesale (no deep merge)", async () => {
      const session = makeSession({
        setupRuntimes: {
          a: {
            state: "pending",
            pluginVersion: "1",
            generation: 1,
            attempts: 0,
          },
          b: {
            state: "pending",
            pluginVersion: "1",
            generation: 1,
            attempts: 0,
          },
        },
      });
      await store.createSession(session);
      await store.updateSession(session.id, {
        setupRuntimes: {
          c: {
            state: "blocked",
            pluginVersion: "1",
            generation: 2,
            attempts: 3,
            reason: "dependency failed",
            blockedAt: ts(),
          },
        },
        updatedAt: ts(),
      });
      const updated = await store.getSession(session.id);
      expect(Object.keys(updated?.setupRuntimes ?? {})).toEqual(["c"]);
      expect(updated?.setupRuntimes?.c?.state).toBe("blocked");
    });

    it("leaves lifecycle fields untouched when the patch omits them", async () => {
      const session = makeSession({ phase: "setup", completedPlayerTurns: 1 });
      await store.createSession(session);
      await store.updateSession(session.id, {
        status: "paused",
        updatedAt: ts(),
      });
      const updated = await store.getSession(session.id);
      expect(updated?.status).toBe("paused");
      expect(updated?.phase).toBe("setup");
      expect(updated?.completedPlayerTurns).toBe(1);
    });
  });

  describe("LogicalTurnLedger", () => {
    it("inserts once, rejects a duplicate logical turn without overwriting", async () => {
      const first = makeLogicalTurnCompletion({
        sessionId: "sess-ltl",
        logicalTurnId: "lt-1",
        completedByExecutionId: "exec-1",
      });
      expect(await store.insertLogicalTurnCompletion(first)).toBe(true);

      const dup = makeLogicalTurnCompletion({
        sessionId: "sess-ltl",
        logicalTurnId: "lt-1",
        completedByExecutionId: "exec-2",
      });
      expect(await store.insertLogicalTurnCompletion(dup)).toBe(false);

      const read = await store.getLogicalTurnCompletion("sess-ltl", "lt-1");
      expect(read?.completedByExecutionId).toBe("exec-1");
    });

    it("returns null for an unrecorded logical turn", async () => {
      expect(
        await store.getLogicalTurnCompletion("sess-ltl", "missing"),
      ).toBeNull();
    });

    it("isolates ledgers between sessions", async () => {
      await store.insertLogicalTurnCompletion(
        makeLogicalTurnCompletion({ sessionId: "sess-A", logicalTurnId: "lt" }),
      );
      // Same logicalTurnId, different session — must be a fresh insert.
      expect(
        await store.insertLogicalTurnCompletion(
          makeLogicalTurnCompletion({
            sessionId: "sess-B",
            logicalTurnId: "lt",
          }),
        ),
      ).toBe(true);
    });
  });

  describe("SetupAttempts", () => {
    it("insert is idempotent on (session, runtime, generation, execution)", async () => {
      const attempt = makeSetupAttempt({
        sessionId: "sess-sa",
        runtimeId: "setup/schema",
        generation: 1,
        executionId: "exec-1",
        state: "started",
      });
      expect(await store.insertSetupAttempt(attempt)).toBe(true);
      expect(
        await store.insertSetupAttempt({ ...attempt, state: "success" }),
      ).toBe(false);

      const rows = await store.listSetupAttempts("sess-sa");
      expect(rows).toHaveLength(1);
      // The rejected duplicate must not have overwritten the original state.
      expect(rows[0]!.state).toBe("started");
    });

    it("terminalises an attempt via updateSetupAttempt", async () => {
      const attempt = makeSetupAttempt({
        sessionId: "sess-sa2",
        runtimeId: "setup/schema",
        generation: 1,
        executionId: "exec-1",
        state: "started",
      });
      await store.insertSetupAttempt(attempt);
      const finishedAt = ts(1000);
      await store.updateSetupAttempt("sess-sa2", "setup/schema", 1, "exec-1", {
        state: "failed",
        finishedAt,
        error: "boom",
      });
      const rows = await store.listSetupAttempts("sess-sa2");
      expect(rows[0]!.state).toBe("failed");
      expect(rows[0]!.finishedAt).toBe(finishedAt);
      expect(rows[0]!.error).toBe("boom");
    });

    it("updateSetupAttempt on an unknown key is a no-op", async () => {
      await store.updateSetupAttempt("sess-none", "r", 1, "e", {
        state: "success",
      });
      expect(await store.listSetupAttempts("sess-none")).toEqual([]);
    });

    it("filters listSetupAttempts by runtimeId and generation", async () => {
      await store.insertSetupAttempt(
        makeSetupAttempt({
          sessionId: "sess-sa3",
          runtimeId: "a",
          generation: 1,
          executionId: "e1",
        }),
      );
      await store.insertSetupAttempt(
        makeSetupAttempt({
          sessionId: "sess-sa3",
          runtimeId: "a",
          generation: 2,
          executionId: "e2",
        }),
      );
      await store.insertSetupAttempt(
        makeSetupAttempt({
          sessionId: "sess-sa3",
          runtimeId: "b",
          generation: 1,
          executionId: "e3",
        }),
      );

      expect(
        await store.listSetupAttempts("sess-sa3", { runtimeId: "a" }),
      ).toHaveLength(2);
      expect(
        await store.listSetupAttempts("sess-sa3", {
          runtimeId: "a",
          generation: 2,
        }),
      ).toHaveLength(1);
      expect(await store.listSetupAttempts("sess-sa3")).toHaveLength(3);
    });

    it("orders listSetupAttempts by startedAt ascending", async () => {
      await store.insertSetupAttempt(
        makeSetupAttempt({
          sessionId: "sess-sa4",
          executionId: "late",
          startedAt: ts(1000),
        }),
      );
      await store.insertSetupAttempt(
        makeSetupAttempt({
          sessionId: "sess-sa4",
          executionId: "early",
          startedAt: ts(0),
        }),
      );
      const rows = await store.listSetupAttempts("sess-sa4");
      expect(rows.map((r) => r.executionId)).toEqual(["early", "late"]);
    });
  });

  describe("JobStatus", () => {
    it("append is idempotent on (jobId, sequence); earlier event wins", async () => {
      const first = makeJobStatus({
        sessionId: "sess-js",
        jobId: "job-1",
        sequence: 0,
        state: "queued",
      });
      expect(await store.appendJobStatus(first)).toBe(true);
      expect(await store.appendJobStatus({ ...first, state: "running" })).toBe(
        false,
      );

      const rows = await store.listJobStatus("sess-js");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("queued");
    });

    it("orders listJobStatus by (jobId, sequence) ascending", async () => {
      await store.appendJobStatus(
        makeJobStatus({ sessionId: "sess-js2", jobId: "b", sequence: 0 }),
      );
      await store.appendJobStatus(
        makeJobStatus({ sessionId: "sess-js2", jobId: "a", sequence: 2 }),
      );
      await store.appendJobStatus(
        makeJobStatus({ sessionId: "sess-js2", jobId: "a", sequence: 1 }),
      );
      const rows = await store.listJobStatus("sess-js2");
      expect(rows.map((r) => [r.jobId, r.sequence])).toEqual([
        ["a", 1],
        ["a", 2],
        ["b", 0],
      ]);
    });

    it("round-trips a nested JsonValue data payload verbatim", async () => {
      const data = {
        nested: { a: 1, b: "two", inner: null },
        arr: [1, "x", true, null],
        flag: false,
      };
      await store.appendJobStatus(
        makeJobStatus({
          sessionId: "sess-js3",
          jobId: "j",
          sequence: 0,
          progress: 0.42,
          message: "half way",
          data,
        }),
      );
      const rows = await store.listJobStatus("sess-js3");
      expect(rows[0]!.data).toEqual(data);
      expect(rows[0]!.progress).toBe(0.42);
      expect(rows[0]!.message).toBe("half way");
    });

    it("collapses a top-level null data to absent (backend parity)", async () => {
      // A nullable JSON column collapses `null` → absent on the SQL backends;
      // Memory/IDB canonicalise the same way, so `data === undefined` on all
      // four. Only a top-level null collapses — a null *inside* data survives
      // (covered by the nested round-trip above).
      await store.appendJobStatus(
        makeJobStatus({
          sessionId: "sess-js4",
          jobId: "j",
          sequence: 0,
          data: null,
        }),
      );
      const rows = await store.listJobStatus("sess-js4");
      expect(rows[0]!.data).toBeUndefined();
    });

    it("filters listJobStatus by progressScopeId and jobId", async () => {
      await store.appendJobStatus(
        makeJobStatus({
          sessionId: "sess-js5",
          progressScopeId: "scope-a",
          jobId: "j1",
          sequence: 0,
        }),
      );
      await store.appendJobStatus(
        makeJobStatus({
          sessionId: "sess-js5",
          progressScopeId: "scope-b",
          jobId: "j2",
          sequence: 0,
        }),
      );
      expect(
        await store.listJobStatus("sess-js5", { progressScopeId: "scope-a" }),
      ).toHaveLength(1);
      expect(
        await store.listJobStatus("sess-js5", { jobId: "j2" }),
      ).toHaveLength(1);
      expect(await store.listJobStatus("sess-js5")).toHaveLength(2);
    });
  });

  describe("Snapshot payload V3", () => {
    it("round-trips a V3 payload's setup-band session state", async () => {
      const payload = makeSnapshotPayloadV3();
      const snap = makeSnapshot({ sessionId: "sess-snap-v3", payload });
      await store.saveSnapshot(snap);

      const result = (await store.getSnapshot(snap.id))!
        .payload as SnapshotPayloadV3;
      expect(result.schemaVersion).toBe(3);
      expect(result.session).toEqual(payload.session);
      expect(result.session.phase).toBe("playing");
      expect(result.session.completedPlayerTurns).toBe(2);
    });
  });
}
