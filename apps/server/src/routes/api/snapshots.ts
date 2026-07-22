/**
 * Snapshot / Fork routes.
 *
 * Materialized state snapshots power save / load / fork.
 *
 *   POST   /api/sessions/:id/snapshot                — create manual snapshot
 *   GET    /api/sessions/:id/snapshots               — list snapshot metadata (paginated)
 *   GET    /api/sessions/:id/snapshots/:snapshotId   — fetch one full snapshot payload
 *   POST   /api/sessions/:id/fork                    — create new session from snapshot
 *
 * Auto snapshots (kind='auto') are written by the server commit pipeline at
 * checkpoint cadence (every COVEL_SNAPSHOT_INTERVAL_TURNS turns; see
 * saveAutoSnapshot); this route module exposes the manual/fork surfaces.
 *
 * Fork strategy: COPY. We rebuild the child session by persisting the
 * snapshot's characters / state entries / plugin data / working memory
 * into the new sessionId. Messages are copied from the parent up to
 * `payload.messagesCursor` — past that cursor the child starts fresh.
 * Copying (rather than referencing) keeps cross-session semantics clean
 * and lets either branch be deleted independently.
 */

import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  collectMediaRefIds,
  deriveLegacyClockFields,
  mirrorSetupCompleted,
} from "@covel/shared";
import type {
  DataStore,
  MediaStore,
  SnapshotRecord,
  SnapshotSessionState,
  CharacterRecord,
  StateEntryRecord,
  PluginDataRecord,
  SuspensionRecord,
  WorkingMemoryRecord,
  TurnMessageRecord,
} from "@covel/store";
import { buildSnapshotPayload } from "@covel/runtime";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { CHARACTER_NAMESPACE } from "@covel/tools";
import type { EventBus } from "@covel/events";
import { errorBody } from "../../api-error.js";
import {
  SessionLockTimeoutError,
  type SessionLock,
} from "../../lib/session-lock.js";
import { SAFE_SESSION_ID_RE } from "../../lib/validators.js";
import { nextCursorFrom, parseCursorQuery } from "./cursor-params.js";
import {
  mintSessionOwnerToken,
  resolveSessionParam,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    sessionLock: SessionLock;
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

/**
 * Translate a bounded lock-acquire timeout (PG advisory lock, 30s) into a
 * coded 503 — a turn can legitimately hold the session lock longer than the
 * acquire budget, and callers should retry rather than see a generic 500.
 */
function rethrowUnlessLockBusy(c: Context<Env>) {
  return (err: unknown) => {
    if (err instanceof SessionLockTimeoutError) {
      return c.json(
        errorBody("Session is busy executing a turn; retry shortly", {
          code: "session_busy",
        }),
        503,
      );
    }
    throw err;
  };
}

export const snapshotRoutes = new Hono<Env>();

// ── POST /api/sessions/:id/snapshot — manual snapshot ─────────────

snapshotRoutes.post("/:id/snapshot", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  const sessionLock = c.get("sessionLock");

  return sessionLock
    .withLock(sessionId, async () => {
      const resolved = await resolveSessionParam(c);
      if (!resolved.ok) return resolved.response;
      const session = resolved.session;

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

      // Emit state.snapshot.created so reactive UI can refresh snapshot lists.
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
    })
    .catch(rethrowUnlessLockBusy(c));
});

// ── GET /api/sessions/:id/snapshots — list snapshot metadata ──────
//
// Snapshot payloads serialize the entire session state, so returning them all
// in one response grows without bound (audit 2026-07-11 R-04). The list now
// returns metadata only (id, turnId, kind, createdAt, parentId, payloadSize)
// with keyset pagination — the store projects the payload column away and
// computes `size` in-SQL, so listing stays O(limit) rows and never loads a
// single payload. Fetch a full payload on demand via
// GET /:id/snapshots/:snapshotId.
//
// Keyset contract matches /messages/page and /traces turns: `?limit`,
// `?before_created_at`, `?before_id` (see cursor-params). No cursor → the
// newest window; cursor → the page immediately older. Rows are oldest-first
// within each page.

const SNAPSHOT_LIST_DEFAULT_LIMIT = 50;

snapshotRoutes.get("/:id/snapshots", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");

  const resolved = await resolveSessionParam(c);
  if (!resolved.ok) return resolved.response;

  const { limit, before } = parseCursorQuery(c, SNAPSHOT_LIST_DEFAULT_LIMIT);
  const page = await store.listSnapshotsPage(sessionId, { limit, before });

  const snapshots = page.map((s) => ({
    id: s.id,
    sessionId: s.sessionId,
    turnId: s.turnId,
    kind: s.kind,
    ...(s.parentId !== undefined ? { parentId: s.parentId } : {}),
    createdAt: s.createdAt,
    payloadSize: s.size,
  }));

  return c.json({ snapshots, nextCursor: nextCursorFrom(page, limit) });
});

// ── GET /api/sessions/:id/snapshots/:snapshotId — full payload ────

snapshotRoutes.get("/:id/snapshots/:snapshotId", async (c) => {
  const sessionId = c.req.param("id");
  const snapshotId = c.req.param("snapshotId");
  const store = c.get("store");

  const resolved = await resolveSessionParam(c);
  if (!resolved.ok) return resolved.response;

  const snapshot = await store.getSnapshot(snapshotId);
  if (!snapshot || snapshot.sessionId !== sessionId) {
    return c.json(errorBody("Snapshot not found", { code: "not_found" }), 404);
  }
  return c.json({ snapshot });
});

// ── POST /api/sessions/:id/fork — fork from snapshot ──────────────

snapshotRoutes.post("/:id/fork", async (c) => {
  const parentSessionId = c.req.param("id");
  const store = c.get("store");
  const sessionLock = c.get("sessionLock");
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

  return sessionLock
    .withLock(parentSessionId, async () => {
      const resolved = await resolveSessionParam(c);
      if (!resolved.ok) return resolved.response;
      const parentSession = resolved.session;

      const snapshot = await store.getSnapshot(fromSnapshotId);
      if (!snapshot || snapshot.sessionId !== parentSessionId) {
        return c.json(
          errorBody("Snapshot not found", { code: "not_found" }),
          404,
        );
      }
      const nowIso = new Date().toISOString();

      // Upgrade-on-read for legacy V1 payloads: they predate lifecycle capture,
      // so fall back to the parent session's CURRENT lifecycle fields — the
      // pre-V2 fork behavior. That mixes two points in time, but it keeps every
      // historical save forkable; V2/V3 snapshots restore the exact captured state.
      const snapshotSession: SnapshotSessionState =
        snapshot.payload.schemaVersion === 2 ||
        snapshot.payload.schemaVersion === 3
          ? snapshot.payload.session
          : {
              status: parentSession.status,
              turnCount: parentSession.turnCount,
              preGameCompleted: parentSession.preGameCompleted,
              locale: parentSession.locale,
              activePlugins: parentSession.activePlugins,
              presetId: parentSession.presetId,
              runtimeModelOverrides: parentSession.runtimeModelOverrides,
            };

      // Scheduling-redesign clock. A V3 snapshot restores it verbatim. V1/V2
      // (and a V3 written before the kernel populated the clock) conservatively
      // backfill it from the legacy turnCount — NEVER parsing turnIds or
      // scanning child turn_results — and record a migration diagnostic. The
      // legacy turnCount / preGameCompleted are re-derived from the clock so
      // both models stay consistent on the child.
      const v3Clock =
        snapshot.payload.schemaVersion === 3 &&
        snapshot.payload.session.phase !== undefined
          ? {
              phase: snapshot.payload.session.phase,
              completedPlayerTurns:
                snapshot.payload.session.completedPlayerTurns ?? 0,
              setupRuntimes: snapshot.payload.session.setupRuntimes ?? {},
            }
          : undefined;
      let forkClockMigration: Record<string, unknown> | undefined;
      const forkClock = v3Clock ?? {
        phase:
          snapshotSession.turnCount === 0
            ? ("setup" as const)
            : ("playing" as const),
        completedPlayerTurns:
          snapshotSession.turnCount === 0 ? 0 : snapshotSession.turnCount,
        setupRuntimes: mirrorSetupCompleted(
          snapshotSession.preGameCompleted,
          nowIso,
        ),
      };
      if (v3Clock === undefined) {
        forkClockMigration = {
          source: "legacy-fork-conservative",
          legacyTurnCount: snapshotSession.turnCount,
          snapshotId: snapshot.id,
        };
      }
      const forkLegacyClock = deriveLegacyClockFields(forkClock);

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
      const childOwner = mintSessionOwnerToken();
      const pluginRegistry = c.get("pluginRegistry");
      const childActivePlugins = snapshotSession.activePlugins.filter(
        (pluginId) => {
          const entry = pluginRegistry?.get(pluginId);
          if (!pluginRegistry) return true;
          if (!entry) return true;
          return getPluginTrustInfo(pluginId, entry?.source).autoLoad;
        },
      );

      const now = nowIso;

      // Scoped transaction: the entire child rebuild (session + characters + state
      // + plugin data + working memory + suspensions + messages + fork snapshot)
      // commits atomically through the tx-bound view. A thrown error auto-rolls-
      // back, so a partial fork can never persist. The out-of-band SSE emits and
      // the 201 response are deferred until after the transaction commits.
      let forkSnapshot: SnapshotRecord;
      try {
        forkSnapshot = await store.withTransaction!(async (tx) => {
          // V2 forks restore lifecycle and runtime selection from the captured
          // point; V1 forks degrade to the parent's current state (see the
          // upgrade-on-read above). `ended` is terminal with no un-end API — a
          // fork exists to keep playing, so clamp it to resumable 'paused'.
          await tx.createSession({
            id: childSessionId,
            worldId: parentSession.worldId,
            status:
              snapshotSession.status === "ended"
                ? "paused"
                : snapshotSession.status,
            // Legacy band/gate fields derived from the restored clock so both
            // models agree on the child from its first row.
            turnCount: forkLegacyClock.turnCount,
            preGameCompleted: forkLegacyClock.preGameCompleted,
            phase: forkClock.phase,
            completedPlayerTurns: forkClock.completedPlayerTurns,
            setupRuntimes: forkClock.setupRuntimes,
            locale: snapshotSession.locale,
            activePlugins: childActivePlugins,
            presetId: snapshotSession.presetId,
            runtimeModelOverrides: snapshotSession.runtimeModelOverrides,
            metadata: {
              [SESSION_OWNER_TOKEN_HASH_KEY]: childOwner.tokenHash,
              ...(forkClockMigration
                ? {
                    runtimeMigration: {
                      completedPlayerTurns: forkClockMigration,
                    },
                  }
                : {}),
            },
            createdAt: now,
            updatedAt: now,
          });

          // Copy characters. Mint fresh ids because several store backends key
          // characters by `id` alone — reusing the parent's id would overwrite
          // the parent's row in those backends. Track old→new so the character
          // mirror plugin-data (keyed by character id) can be remapped below.
          const characterIdMap = new Map<string, string>();
          for (const ch of snapshot.payload.characters) {
            const newId = randomUUID();
            characterIdMap.set(ch.id, newId);
            const record: CharacterRecord = {
              ...ch,
              id: newId,
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

          // Copy plugin data. The character-mirror namespace keys each row by the
          // character id and stores the character (value.id = same id). Characters
          // were re-minted above, so remap those rows' key + value.id to the child
          // ids — otherwise the mirror references characters that don't exist in
          // the child, desyncing UI panels and duplicating on the next update.
          const pluginDataBatch: PluginDataRecord[] =
            snapshot.payload.pluginData.map((pd) => {
              const base: PluginDataRecord = {
                ...pd,
                id: randomUUID(),
                sessionId: childSessionId,
              };
              if (pd.namespace !== CHARACTER_NAMESPACE) return base;
              const newId = characterIdMap.get(pd.key);
              if (!newId) return base;
              const value =
                base.value && typeof base.value === "object"
                  ? { ...(base.value as Record<string, unknown>), id: newId }
                  : base.value;
              return { ...base, key: newId, value };
            });
          if (pluginDataBatch.length > 0) {
            await tx.setPluginDataBatch(pluginDataBatch);
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

          // Copy session-scoped lorebook entries. Missing before, so a fork lost
          // every lore/world entry the parent accumulated during play, and the
          // child's world-entries prompt injection came back empty.
          // (sessionId, id) is the composite key, so keeping the original id
          // is safe.
          if (snapshot.payload.lorebookEntries.length > 0) {
            await tx.upsertLorebookEntries(
              snapshot.payload.lorebookEntries.map((lb) => ({
                ...lb,
                sessionId: childSessionId,
              })),
            );
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

      // Post-commit side effects: the fork is durable, so the following run OUT of
      // the DataStore transaction.
      //
      // Conservative-fork diagnostic: a legacy (V1/V2) snapshot could not carry
      // completedPlayerTurns, so the child's count was backfilled from turnCount.
      // Surface it as a trace event alongside the durable metadata note so the
      // /debug timeline shows why the child's count may differ from the parent's.
      // Best-effort — a diagnostic must never fail an already-durable fork.
      if (forkClockMigration) {
        try {
          await store.addTraceEvent({
            id: randomUUID(),
            sessionId: childSessionId,
            type: "runtime.migration.fork-conservative",
            traceId: forkSnapshot.id,
            turnId: "",
            payload: forkClockMigration,
            createdAt: now,
          });
        } catch (err) {
          console.warn(
            `[fork] migration diagnostic failed for ${childSessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Media refs first — MediaStore is a separate store whose writes a rollback
      // could not undo, so adding them only after the fork commits guarantees we
      // never leave an orphaned media ref pointing at a child session that was
      // rolled back (e.g. the cursor-missing 409 path). addRef is idempotent; a
      // failure here is logged but does not fail an already-durable fork.
      if (mediaStore) {
        const mediaIds = collectMediaRefIds(snapshot.payload);
        for (const mediaId of mediaIds) {
          try {
            await mediaStore.addRef(mediaId, childSessionId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[fork] media addRef failed for ${mediaId} -> ${childSessionId}: ${message}`,
            );
          }
        }
      }

      // Then emit session.forked on the event bus (out-of-band SSE listeners pick
      // it up and update any session lists they show). Kernel-only when eventBus is
      // absent in tests.
      const eventBus = c.get("eventBus");
      if (eventBus) {
        // Also publish state.snapshot.created (kind='fork') so a
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
          ownerToken: childOwner.token,
        },
        201,
      );
    })
    .catch(rethrowUnlessLockBusy(c));
});
