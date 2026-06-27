/**
 * Snapshot / Fork routes (S4-T2, §A6).
 *
 * Materialized state snapshots power save / load / fork.
 *
 *   POST   /api/sessions/:id/snapshot    — create manual snapshot
 *   GET    /api/sessions/:id/snapshots   — list snapshots
 *   POST   /api/sessions/:id/fork        — create new session from snapshot
 *
 * Auto snapshots (kind='auto') are written by the turn-executor at turn
 * commit time; this route module only exposes the manual/fork surfaces.
 *
 * Fork strategy: COPY. We rebuild the child session by persisting the
 * snapshot's characters / state entries / plugin data / working memory
 * into the new sessionId. Messages are copied from the parent up to
 * `payload.messagesCursor` — past that cursor the child starts fresh.
 * Copying (rather than referencing) keeps cross-session semantics clean
 * and lets either branch be deleted independently.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { collectMediaRefIds } from "@covel/shared";
import type {
  DataStore,
  MediaStore,
  SnapshotRecord,
  CharacterRecord,
  StateEntryRecord,
  PluginDataRecord,
  SuspensionRecord,
  WorkingMemoryRecord,
  TurnMessageRecord,
} from "@covel/store";
import { buildSnapshotPayload } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import { errorBody } from "../../api-error.js";
import { SAFE_SESSION_ID_RE } from "../../lib/validators.js";

type Env = {
  Variables: {
    store: DataStore;
    eventBus?: EventBus;
    mediaStore?: MediaStore;
  };
};

/**
 * Internal sentinel: the snapshot cursor vanished from the parent session
 * mid-fork. Thrown to roll back the fork `withTransaction`, then translated to
 * a 409 by the route handler (rather than the catch-all 500).
 */
class ForkCursorMissingError extends Error {}

export const snapshotRoutes = new Hono<Env>();

// ── POST /api/sessions/:id/snapshot — manual snapshot ─────────────

snapshotRoutes.post("/:id/snapshot", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found", { code: "not_found" }), 404);
  }

  // Derive a turnId for the snapshot — use the latest turn_result we can
  // find, or fall back to the session's turnCount so fresh sessions still
  // produce a usable label.
  const turnResults = await store.listTurnResults(sessionId);
  const latestTurnId =
    turnResults.length > 0
      ? turnResults[turnResults.length - 1]!.turnId
      : `turn-${session.turnCount}`;

  let payload;
  try {
    payload = await buildSnapshotPayload(store, sessionId, latestTurnId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      errorBody(`Failed to build snapshot payload: ${message}`, {
        code: "build_failed",
      }),
      500,
    );
  }

  const now = new Date().toISOString();
  const snapshot: SnapshotRecord = {
    id: randomUUID(),
    sessionId,
    turnId: latestTurnId,
    kind: "manual",
    payload,
    createdAt: now,
  };

  await store.saveSnapshot(snapshot);

  // S4-T5: Emit state.snapshot.created so reactive UI can refresh snapshot lists.
  // EventBus is optional in tests; only emit when bound.
  const eventBus = c.get("eventBus");
  if (eventBus) {
    eventBus.emit({
      id: randomUUID(),
      type: "event",
      topic: "session",
      sessionId,
      timestamp: now,
      payload: {
        _subTopic: "session",
        _subType: "state.snapshot.created",
        turnId: latestTurnId,
        snapshotId: snapshot.id,
        kind: "manual",
      },
    });
  }

  return c.json({ snapshot }, 201);
});

// ── GET /api/sessions/:id/snapshots — list snapshots ──────────────

snapshotRoutes.get("/:id/snapshots", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found", { code: "not_found" }), 404);
  }

  const snapshots = await store.listSnapshots(sessionId);
  return c.json({ snapshots });
});

// ── POST /api/sessions/:id/fork — fork from snapshot ──────────────

snapshotRoutes.post("/:id/fork", async (c) => {
  const parentSessionId = c.req.param("id");
  const store = c.get("store");
  const mediaStore = c.get("mediaStore");

  let body: { fromSnapshotId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      errorBody("Invalid JSON body", { code: "invalid_body" }),
      400,
    );
  }

  const fromSnapshotId =
    typeof body.fromSnapshotId === "string" ? body.fromSnapshotId : undefined;
  if (!fromSnapshotId) {
    return c.json(
      errorBody("fromSnapshotId is required", { code: "invalid_body" }),
      400,
    );
  }

  const parentSession = await store.getSession(parentSessionId);
  if (!parentSession) {
    return c.json(
      errorBody("Parent session not found", { code: "not_found" }),
      404,
    );
  }

  const snapshot = await store.getSnapshot(fromSnapshotId);
  if (!snapshot || snapshot.sessionId !== parentSessionId) {
    return c.json(errorBody("Snapshot not found", { code: "not_found" }), 404);
  }

  // Mint the child session id. Format `{worldId}-{uuid8}` matches
  // POST /api/sessions (session.ts). worldId falls back to 'fork' for
  // sessions without one — SAFE_SESSION_ID_RE still accepts it.
  const prefix = parentSession.worldId ?? "fork";
  const childSessionId = `${prefix}-${randomUUID().slice(0, 8)}`;
  if (!SAFE_SESSION_ID_RE.test(childSessionId)) {
    // Defensive — worldId already validated on parent creation, but fail
    // loudly rather than persist an id that would trip other routes.
    return c.json(
      errorBody("Failed to mint valid child session id", {
        code: "fork_failed",
      }),
      500,
    );
  }

  const now = new Date().toISOString();

  // Scoped transaction: the entire child rebuild (session + characters + state
  // + plugin data + working memory + suspensions + messages + fork snapshot)
  // commits atomically through the tx-bound view. A thrown error auto-rolls-
  // back, so a partial fork can never persist. The out-of-band SSE emits and
  // the 201 response are deferred until after the transaction commits.
  let forkSnapshot: SnapshotRecord;
  try {
    forkSnapshot = await store.withTransaction!(async (tx) => {
      // Create the child session. Reuse parent's locale + activePlugins so
      // the forked run lands on the same plugin scope.
      await tx.createSession({
        id: childSessionId,
        worldId: parentSession.worldId,
        status: parentSession.status,
        turnCount: parentSession.turnCount,
        preGameCompleted: parentSession.preGameCompleted,
        locale: parentSession.locale,
        activePlugins: parentSession.activePlugins,
        createdAt: now,
        updatedAt: now,
      });

      // Copy characters. Mint fresh ids because several store backends key
      // characters by `id` alone — reusing the parent's id would overwrite
      // the parent's row in those backends.
      for (const ch of snapshot.payload.characters) {
        const record: CharacterRecord = {
          ...ch,
          id: randomUUID(),
          sessionId: childSessionId,
        };
        await tx.upsertCharacter(record);
      }

      // Copy state schemas (needed so stateEntries can be listed by the child)
      const parentSchemas = await tx.listStateSchemas(parentSessionId);
      for (const s of parentSchemas) {
        await tx.saveStateSchema({
          ...s,
          id: randomUUID(),
          sessionId: childSessionId,
          createdAt: now,
        });
      }

      // Copy state entries
      for (const se of snapshot.payload.stateEntries) {
        const record: StateEntryRecord = {
          ...se,
          id: randomUUID(),
          sessionId: childSessionId,
        };
        await tx.upsertStateEntry(record);
      }

      // Copy plugin data
      const pluginDataBatch: PluginDataRecord[] =
        snapshot.payload.pluginData.map((pd) => ({
          ...pd,
          id: randomUUID(),
          sessionId: childSessionId,
        }));
      if (pluginDataBatch.length > 0) {
        await tx.setPluginDataBatch(pluginDataBatch);
      }

      if (mediaStore) {
        const mediaIds = collectMediaRefIds(snapshot.payload);
        for (const mediaId of mediaIds) {
          await mediaStore.addRef(mediaId, childSessionId);
        }
      }

      // Copy working memory
      for (const wm of snapshot.payload.workingMemory) {
        const record: WorkingMemoryRecord = {
          ...wm,
          id: randomUUID(),
          sessionId: childSessionId,
        };
        await tx.upsertWorkingMemory(record);
      }

      // Copy unresolved suspensions (audit 2026-04-20 finding 7.3). Each
      // record is rebound to the child session with a fresh id so the parent
      // copy remains untouched. `pendingContinuation` is preserved verbatim —
      // POST /resume on the child uses the new id to re-enter the tool loop.
      for (const susp of snapshot.payload.suspensions) {
        const record: SuspensionRecord = {
          ...susp,
          id: randomUUID(),
          sessionId: childSessionId,
        };
        await tx.saveSuspension(record);
      }

      // Copy turn messages up to and including the snapshot's cursor.
      // Strategy: read all parent messages in order, verify the cursor still
      // exists (was not compacted away / deleted), then copy 0..cursorIdx
      // inclusive with fresh ids to the child. Empty cursor = no messages.
      //
      // Audit 2026-04-20 finding 7.1: previously the loop copied ALL parent
      // messages silently when the cursor id could not be found. Now the
      // missing cursor surfaces as a 409 so callers can decide how to recover
      // rather than inheriting an unbounded prefix.
      if (snapshot.payload.messagesCursor !== "") {
        const parentMessages = await tx.listTurnMessages(parentSessionId);
        const cursorIdx = parentMessages.findIndex(
          (m) => m.id === snapshot.payload.messagesCursor,
        );
        if (cursorIdx === -1) {
          // Roll back the partial fork; translated to a 409 by the caller.
          throw new ForkCursorMissingError();
        }
        for (let i = 0; i <= cursorIdx; i++) {
          const m = parentMessages[i]!;
          const copy: TurnMessageRecord = {
            ...m,
            id: randomUUID(),
            sessionId: childSessionId,
          };
          await tx.appendTurnMessage(copy);
        }
      }

      // Record a 'fork' snapshot on the child so the provenance graph is
      // traversable from either direction.
      const built: SnapshotRecord = {
        id: randomUUID(),
        sessionId: childSessionId,
        turnId: snapshot.turnId,
        kind: "fork",
        parentId: snapshot.id,
        payload: snapshot.payload,
        createdAt: now,
      };
      await tx.saveSnapshot(built);
      return built;
    });
  } catch (err) {
    if (err instanceof ForkCursorMissingError) {
      return c.json(
        errorBody("Snapshot cursor no longer exists in parent session", {
          code: "cursor_missing",
        }),
        409,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      errorBody(`Fork failed: ${message}`, { code: "fork_failed" }),
      500,
    );
  }

  // Post-commit: the fork is durable. Emit session.forked on the event bus
  // (out-of-band SSE listeners pick it up and update any session lists they
  // show). Kernel-only when eventBus is absent in tests.
  const eventBus = c.get("eventBus");
  if (eventBus) {
    // S4-T5: also publish state.snapshot.created (kind='fork') so a
    // forked session's snapshot list reacts immediately.
    eventBus.emit({
      id: randomUUID(),
      type: "event",
      topic: "session",
      sessionId: childSessionId,
      timestamp: now,
      payload: {
        _subTopic: "session",
        _subType: "state.snapshot.created",
        turnId: snapshot.turnId,
        snapshotId: forkSnapshot.id,
        kind: "fork",
        parentSnapshotId: snapshot.id,
      },
    });

    eventBus.emit({
      id: randomUUID(),
      type: "event",
      topic: "session",
      sessionId: childSessionId,
      timestamp: now,
      payload: {
        _subTopic: "session",
        _subType: "session.forked",
        parentSessionId,
        childSessionId,
        fromSnapshotId: snapshot.id,
        forkSnapshotId: forkSnapshot.id,
      },
    });
  }

  return c.json(
    {
      sessionId: childSessionId,
      parentSessionId,
      fromSnapshotId: snapshot.id,
      forkSnapshotId: forkSnapshot.id,
    },
    201,
  );
});
