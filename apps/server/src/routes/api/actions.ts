/**
 * Actions route — SSE bridge between frontend action protocol and turn executor.
 *
 * Translates action requests (send_message, execute_command, etc.)
 * into turn execution and streams results back as SSE events.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DataStore, MediaStore } from "@covel/store";
import type { PluginRegistry, LoadedRuntime } from "@covel/plugin-loader";
import type { LLMAdapter, ToolExecutor, HookPipeline } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import {
  executeTurn,
  createTraceRecorder,
  createTurnEmitter,
  saveAutoSnapshot,
} from "@covel/runtime";
import type { CovelEventType, RuntimeManifest } from "@covel/shared";
import { FORWARDED_EVENT_TYPES } from "@covel/shared";
import { estimateTokens } from "@covel/context";
import type { CompactorRunner } from "@covel/context";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { createRuntimeResultProcessor } from "./runtime-result-processor.js";
import { createPluginRpcJobRunner } from "./plugin-rpc/background-jobs.js";
import { createPluginRpcRuntimeTurnRunner } from "./plugin-rpc/runtime-turn.js";
import { resolveTurnCapabilityPluginIds } from "./turn-capabilities.js";
import { syncSessionTurnCount } from "./turn-count.js";
import { decodePluginUserSettingsHeader } from "./plugin-rpc/body.js";
import {
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "./plugin-user-settings.js";
import { getCachedWorld } from "../../world-cache.js";
import { registerActiveTurn } from "./turn-control.js";
import { checkSessionOwner } from "./session/session-guard.js";

// SSE uses ProtocolEventType names directly — no legacy mapping.
// Frontend handleSseEvent handles these standard types.

/**
 * Memory-system facade injected by bootstrap via `setMemorySystem()`. Kept
 * out of `Env["Variables"]` because it never flows through Hono's
 * `c.set`/`c.get` — see the module-level reference below.
 */
interface MemorySystemFacade {
  readonly manager: {
    loadBlocks(
      sid: string,
    ): Promise<
      readonly { label: string; content: string; updatedAt: string }[]
    >;
    initializeDefaults(sid: string): Promise<void>;
  };
  readonly updater: {
    updateAfterTurn(p: {
      sessionId: string;
      narrativeText: string;
      toolCallSummaries?: readonly string[];
      currentBlocks: readonly {
        label: string;
        content: string;
        updatedAt: string;
      }[];
      locale?: string;
    }): Promise<{
      updated: boolean;
      blocksChanged: readonly string[];
      error?: string;
    }>;
  };
}

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (
      manifest: RuntimeManifest,
      locale?: string,
    ) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    resolveModel: (
      manifest: RuntimeManifest,
      apiOverride?: string,
    ) => string | undefined;
    eventBus: EventBus;
    compactorRunner: CompactorRunner;
    mediaStore?: MediaStore;
    hookPipeline?: HookPipeline;
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  };
};

export const actionRoutes = new Hono<Env>();

// Module-level memory system reference, set by bootstrap via setMemorySystem().
// Using a module variable instead of Hono context because Hono's typed
// c.set/c.get doesn't support optional cross-module types cleanly.
let _memorySystem: MemorySystemFacade | undefined;
export function setMemorySystem(ms: MemorySystemFacade | undefined) {
  _memorySystem = ms;
}

interface ActionRequest {
  requestId: string;
  type: string;
  sessionId: string;
  locale?: string;
  model?: string;
  payload: Record<string, unknown>;
}

actionRoutes.post("/", rateLimiter({ max: 30 }), async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const llmAdapter = c.get("llmAdapter");
  const pluginGateway = c.get("pluginGateway");
  const pluginUtils = c.get("pluginUtils");
  const getPluginSource = c.get("getPluginSource");
  const loadRuntimeFn = c.get("loadRuntimeFn");
  const toolExecutor = c.get("toolExecutor");
  const resolveModel = c.get("resolveModel");
  const eventBus = c.get("eventBus");
  const compactorRunner = c.get("compactorRunner");
  const turnContextBudget = c.get("turnContextBudget");
  const sessionLock = c.get("sessionLock");
  const mediaStore = c.get("mediaStore");
  const eventDirectory = c.get("eventDirectory");
  const prepareToolsForSession = c.get("prepareToolsForSession"); // optional — see env.d.ts

  const body = (await c.req
    .json<ActionRequest>()
    .catch(() => null)) as ActionRequest | null;
  if (!body || typeof body !== "object") {
    return c.json(errorBody("Request body must be a JSON object"), 400);
  }
  const { requestId, type, sessionId, locale, model, payload } = body;

  // `trigger_event` was removed : its payload was never read and no UI
  // called it — the request just re-ran a full turn. Emitting kernel events
  // belongs to plugins via the builtin `emit-event` tool.
  const SUPPORTED_ACTIONS = [
    "send_message",
    "execute_command",
    "start_session",
    "retry_runtime",
  ];
  if (!SUPPORTED_ACTIONS.includes(type)) {
    return c.json(errorBody(`Unsupported action type: ${type}`), 400);
  }

  // Every action except start_session dereferences `payload` (content /
  // command / …); a request missing it would throw a TypeError → opaque 500.
  if (type !== "start_session" && (!payload || typeof payload !== "object")) {
    return c.json(
      errorBody(`payload (object) is required for action "${type}"`),
      400,
    );
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found"), 404);
  }

  // Owner guard (hosted tiers, S-02): actions execute turns and spend tokens
  // on the session's behalf.
  const ownerDenied = checkSessionOwner(c, session);
  if (ownerDenied) return ownerDenied;

  // Fast path: a paused/ended session takes no actions. The
  // authoritative re-check happens under the session lock below (this read is
  // racy), but rejecting here returns a clean 409 before the SSE stream opens.
  if (session.status && session.status !== "active") {
    return c.json(
      errorBody(
        `session is ${session.status}; it must be active to accept actions`,
      ),
      409,
    );
  }

  // Lazy-lock the session's embedding model once per process boot.
  // No-op when the store has no vector capability or no embed slot is
  // configured. See apps/server/src/embedding-lock.ts for rationale.
  const ensureEmbeddingLock = c.get("ensureEmbeddingLock");
  if (ensureEmbeddingLock) {
    try {
      await ensureEmbeddingLock(sessionId);
    } catch (err) {
      // Don't fail the turn if the lock can't be established —
      // RAG plugins will simply receive an empty vector store.
      // eslint-disable-next-line no-console
      console.warn(
        `[actions] embedding lock failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const playerMessage =
    type === "start_session"
      ? "" // First turn has no player message
      : ((payload.content as string) ?? (payload.command as string) ?? "");
  const turnId = crypto.randomUUID();

  // Locale: an explicit request.locale (sent by the client on every turn
  // based on the live UI language) wins over the session's stored locale so
  // users who toggle language mid-session see matching LLM output. The
  // session.locale still acts as the fallback when the client omits it.
  const effectiveLocale = locale ?? session.locale ?? "zh-CN";

  // Persist the live locale so server-initiated turns — plugin-rpc manual
  // triggers and deferred background followers, which build TurnInput.locale
  // from the stored session.locale — inherit the player's current UI language
  // instead of a stale value. Only write when it actually changed.
  if (effectiveLocale !== session.locale) {
    await store.updateSession(sessionId, {
      locale: effectiveLocale,
      updatedAt: new Date().toISOString(),
    });
  }

  // Ensure session's plugins are activated in the registry (idempotent, needed
  // after server restart).
  //
  // A `start_session` with an empty plugin set used to activate EVERY
  // registered plugin and persist that — including community plugins the
  // player never chose and mutually-exclusive ones (both narrative engines at
  // once), which then ran for the life of the session. Session creation is
  // what picks the plugin set; an empty set here means the caller skipped that
  // step, so fail loudly instead of inventing one.
  const sessionPlugins = session.activePlugins as readonly string[] | undefined;
  if (
    type === "start_session" &&
    (!sessionPlugins || sessionPlugins.length === 0)
  ) {
    return c.json(
      errorBody(
        "Session has no active plugins. Create the session with an explicit " +
          "plugin set (or a world whose manifest seeds one) before starting it.",
      ),
      400,
    );
  }
  if (sessionPlugins) {
    for (const pid of sessionPlugins) {
      pluginRegistry.activate(pid, sessionId);
    }
  }

  // Get active runtimes for this session (sorted by priority)
  const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);

  // Resolve runtime display kind from manifest declarations for progress SSE.
  // The commit path creates its own processor once the per-turn emitter exists.
  const outputKindResolver = createRuntimeResultProcessor({
    store,
    sessionId,
    runtimes: activeRuntimes,
  });

  // Framework-capability plugin ids discovered by capability — never by id.
  // Single source of truth in resolveTurnCapabilityPluginIds.
  const capabilityPluginIds = resolveTurnCapabilityPluginIds(
    pluginRegistry,
    sessionId,
  );

  return streamSSE(c, async (stream) => {
    let seq = 0;
    const traceId = crypto.randomUUID();
    // W4: released in the finally below so a crashed stream never leaves a
    // stale steer/abort target behind.
    let releaseTurnControl: (() => void) | undefined;

    function makeEnvelope(
      eventType: string,
      eventPayload: Record<string, unknown>,
    ) {
      return {
        type: eventType,
        requestId,
        traceId,
        sessionId,
        turnId,
        flowId: traceId,
        seq: seq++,
        timestamp: new Date().toISOString(),
        payload: eventPayload,
      };
    }

    // Subscribe to out-of-band eventBus events (e.g. plugin-data.changed from
    // store proxy writes) and forward them to the action SSE stream. Without
    // this, events emitted by tool calls during the turn never reach the
    // frontend and UI state (character panel, codex, etc.) desyncs.
    //
    // Note: EventBus strips `_subType` from the raw payload and puts it on
    // `event.type`. So we whitelist by `event.type`, not by payload fields.
    // `turn.suspended` / `turn.resumed` must ride this whitelist too: they
    // are emitted through `emitSubEvent` (via the shared eventBus) rather
    // than through the `onRuntimeStart` / `onRuntimeComplete` callbacks, so
    // without this the action stream never delivers them to the web client
    // and the suspend/resume panel in the UI stays empty.
    //
    // The whitelist is DERIVED from the `CovelEvent` union via
    // `COVEL_EVENT_META[type].forwardToActionStream` (see
    // packages/shared/src/types/protocol.ts) — never hand-maintained here. Add
    // a forwarded event by flipping its meta flag; this Set updates for free.
    // `ev.type` is an untrusted runtime string, so it is narrowed at this
    // boundary before the membership check.
    //
    // the subscription is established INSIDE the session lock (see
    // below), not here. Subscribing before the lock meant a second action
    // queued on the same session received the FIRST action's events while
    // waiting, wrapped them in its own turnId/traceId envelope, and streamed
    // them to its client as its own turn. It stays live through the post-lock
    // tail (deferred followers) and is torn down in the finally.
    let eventBusUnsubscribe: (() => void) | undefined;
    const subscribeEventForwarding = (): void => {
      eventBusUnsubscribe = eventBus.onEmit((ev) => {
        if (ev.sessionId !== sessionId) return;
        if (!FORWARDED_EVENT_TYPES.has(ev.type as CovelEventType)) return;
        const payload = { ...(ev.payload as Record<string, unknown>) };
        stream
          .writeSSE({ data: JSON.stringify(makeEnvelope(ev.type, payload)) })
          .catch(() => {
            /* stream closed, unsubscribe handles cleanup */
          });
      });
    };

    try {
      const { result, trace, userSettings } = await sessionLock.withLock(
        sessionId,
        async () => {
          // This execution now owns the session — events on the bus
          // from here on belong to this turn.
          subscribeEventForwarding();

          // Authoritative gate: re-read the session status under the
          // lock BEFORE any write. A pause/end that raced the pre-stream
          // check must not get player messages, interaction records, or
          // compaction appended to a non-active session. The throw surfaces
          // as an `error.occurred` SSE event via the outer catch.
          const liveSession = await store.getSession(sessionId);
          if (!liveSession) {
            throw new Error("session was deleted while the action was queued");
          }
          if (liveSession.status && liveSession.status !== "active") {
            throw new Error(
              `session is ${liveSession.status}; it must be active to accept actions`,
            );
          }

          // Persist player message to messages table (source of truth for refresh recovery)
          if (playerMessage) {
            const now = new Date().toISOString();
            await store.addMessage({
              id: crypto.randomUUID(),
              sessionId,
              role: "user",
              content: playerMessage,
              metadata: { turnId },
              createdAt: now,
            });

            // PR-1: also emit a normalised InteractionRecord so observability and
            // downstream consumers see the player's input as part of the unified
            // event stream (paired with RuntimeOutput records written by the
            // turn executor).
            try {
              await store.saveInteractionRecord({
                id: crypto.randomUUID(),
                sessionId,
                turnId,
                timestamp: now,
                source: "player",
                channel: "web",
                type: type === "send_message" ? "message" : "rpc-call",
                payload: { content: playerMessage, actionType: type },
                createdAt: now,
              });
            } catch (err) {
              console.warn(
                "[actions] saveInteractionRecord failed:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }

          // Create trace recorder for this turn (persists all lifecycle events
          // to DB). Carries the SSE traceId so recorder rows correlate with
          // emitter + commit-pipeline rows under one traceId (audit R-14).
          const trace = createTraceRecorder(store, sessionId, turnId, traceId);

          // Per-turn trace emitter — fans emit() into trace_events + eventBus. Threaded
          // down into ToolCallContext / llm-retry / hooks etc. via executeTurn deps.
          // Pass the SSE envelope's traceId so persisted trace_events.traceId matches
          // the live-streamed traceId/flowId (without it the emitter falls back to
          // turnId, breaking traceId correlation between SSE and /api/traces).
          const emitter = createTurnEmitter({
            store,
            eventBus,
            sessionId,
            turnId,
            traceId,
          });

          // NOTE: Session `phase` is no longer a first-class field. The state
          // model is `status + turnCount + preGameCompleted`, so there is no
          // `phase.changed` event to emit here — callers that still care about a
          // coarse "pre-game vs playing" display label derive it from
          // `turnCount === 0` vs `> 0`. See audits/2026-04-21-architecture-code-audit.

          // Emit execution started (protocol: execution.started)
          await trace.turnStarted({ runtimeCount: activeRuntimes.length });
          await stream.writeSSE({
            data: JSON.stringify(
              makeEnvelope("execution.started", {
                status: "executing",
                runtimeCount: activeRuntimes.length,
              }),
            ),
          });

          // Refresh the per-session character-tool overrides so create/update-
          // character expose the world's CharacterAttributeSchema directly to
          // the LLM (Phase 2). No-op when the schema isn't yet populated for
          // this session — handlers stay correct on schema-less sessions. The
          // optional-chain keeps tests with hand-built DI middleware working.
          await prepareToolsForSession?.(sessionId);

          // Execute turn through the API pipeline.
          //
          // The outer session lock serializes the complete mutation pipeline:
          // player input, execution, proposal commits, lifecycle sync, and the
          // final automatic snapshot. For PG-backed deployments it uses
          // `pg_advisory_lock`; memory/sqlite use the in-process chain lock.
          // Resolve plugin userSettings for this turn: world-authored defaults
          // (WorldRecord.metadata.pluginSettings) merged under the player's
          // per-session overrides (X-Plugin-User-Settings header). The runtime's
          // resolveUserSettings fills any still-missing declared key from the
          // manifest default. Without this the scheduled loop only ever saw
          // manifest defaults — player + world tuning were silently dropped on the
          // main route (only plugin-rpc read the header).
          const world = session.worldId
            ? await getCachedWorld(store, session.worldId)
            : null;
          const userSettings = mergePluginUserSettings(
            readWorldPluginSettings(world?.metadata),
            decodePluginUserSettingsHeader(
              c.req.header("X-Plugin-User-Settings"),
            ),
          );

          const turnInput = {
            sessionId,
            turnId,
            playerMessage,
            locale: effectiveLocale,
            modelOverride: model,
            ...(userSettings ? { userSettings } : {}),
            // PR-6: snapshot session-level per-runtime slot overrides so the
            // turn executor can consult them when resolving each runtime's
            // model. The session record was loaded above (line ~67).
            ...(session?.runtimeModelOverrides
              ? { runtimeModelOverrides: session.runtimeModelOverrides }
              : {}),
            ...(type === "start_session"
              ? { suppressPlayerMessage: true }
              : {}),
            // retry_runtime honors payload.runtimeId: scope the rerun
            // to that runtime via the manual-trigger path instead of silently
            // re-running the whole turn. Without a runtimeId the action keeps
            // its historical whole-turn-retry semantics.
            ...(type === "retry_runtime" &&
            typeof payload.runtimeId === "string" &&
            payload.runtimeId.length > 0
              ? { manualTrigger: { runtimeId: payload.runtimeId } }
              : {}),
          };
          // W4: register the in-flight turn only after this action owns the
          // session lock. Release control after execution while retaining the
          // lock through proposal commit, lifecycle sync, and snapshot capture.
          const registeredTurn = registerActiveTurn(sessionId, turnId);
          releaseTurnControl = registeredTurn.release;
          let result;
          try {
            result = await executeTurn(turnInput, activeRuntimes, {
              loadRuntime: loadRuntimeFn,
              llm: llmAdapter,
              // The main turn path never passed the eventBus, so every
              // `emitSubEvent` inside the executor — including the
              // completion barrier's `turn.completed` — silently no-opped on
              // the player-facing path (found while adding the
              // fault-injection tests). Without it the barrier's only
              // observable effect was memory ingestion.
              eventBus,
              ...(pluginGateway ? { gateway: pluginGateway } : {}),
              ...(pluginUtils ? { utils: pluginUtils } : {}),
              ...(getPluginSource ? { getPluginSource } : {}),
              store,
              ...(mediaStore ? { mediaStore } : {}),
              toolExecutor,
              resolveModel,
              emitter,
              onDelta: async (delta) => {
                await stream.writeSSE({
                  data: JSON.stringify(
                    makeEnvelope("narrative.delta", {
                      runtimeId: delta.runtimeId,
                      pluginId: delta.pluginId,
                      kind: outputKindResolver.getOutputKind(delta.runtimeId),
                      delta: delta.textDelta,
                    }),
                  ),
                });
              },
              onRuntimeStart: async (info) => {
                await trace.runtimeStarted({
                  runtimeId: info.runtimeId,
                  pluginId: info.pluginId,
                  priority: info.priority,
                });
                const kind = outputKindResolver.getOutputKind(info.runtimeId);
                await stream.writeSSE({
                  data: JSON.stringify(
                    makeEnvelope("runtime.started", {
                      runtimeId: info.runtimeId,
                      pluginId: info.pluginId,
                      kind,
                      label: info.pluginId + "/" + kind,
                    }),
                  ),
                });
              },
              onRuntimeComplete: async (info) => {
                await trace.runtimeCompleted({
                  runtimeId: info.runtimeId,
                  pluginId: info.pluginId,
                  status: info.status,
                  durationMs: info.durationMs,
                });
                const eventType =
                  info.status === "failed"
                    ? "runtime.failed"
                    : info.status === "skipped"
                      ? "runtime.skipped"
                      : "runtime.completed";
                await stream.writeSSE({
                  data: JSON.stringify(
                    makeEnvelope(eventType, {
                      runtimeId: info.runtimeId,
                      pluginId: info.pluginId,
                      durationMs: info.durationMs,
                      status: info.status,
                      ...(info.status === "failed" && info.error
                        ? { error: info.error }
                        : {}),
                    }),
                  ),
                });
              },
              compactor: compactorRunner,
              // Prompt-assembly hard prune — last line of defense when
              // compaction is skipped/vetoed/insufficient for the model window.
              ...(turnContextBudget
                ? {
                    estimator: estimateTokens,
                    contextBudget: turnContextBudget,
                  }
                : {}),
              memorySystem: _memorySystem,
              // Let the turn executor construct a unified SessionContextSnapshot.
              capabilityPluginIds,
              ...(eventDirectory ? { eventDirectory } : {}),
              // W4: player mid-turn steering + abort.
              turnControl: registeredTurn.turnControl,
            });
          } finally {
            registeredTurn.release();
          }

          // Process all runtime results through Session Kernel:
          // normalize output → commit to Store → emit SessionEvents as SSE.
          //
          // hookPipeline / eventBus are forwarded so `PreStateCommit` and
          // `PostStateCommit` hooks declared by plugins actually fire on the
          // production write path (previously they only ran in tests).
          const hookPipeline = c.get("hookPipeline");
          const resultProcessor = createRuntimeResultProcessor({
            store,
            sessionId,
            runtimes: activeRuntimes,
            ...(hookPipeline ? { hookPipeline } : {}),
            eventBus,
            emitter,
          });
          // Commit failures are no longer silently dropped — each one
          // is surfaced as a `proposal.failed` SSE event, and any failure
          // withholds the completion barrier below (turn.completed, memory
          // ingestion, auto-snapshot success signal).
          let commitFailureCount = 0;
          // Nested recursiveCall results ride the same commit barrier —
          // their proposals were previously dropped (only the top-level
          // results were processed).
          for (const rr of [
            ...result.runtimeResults,
            ...(result.nestedRuntimeResults ?? []),
          ]) {
            const { events, failedProposals } =
              await resultProcessor.process(rr);

            for (const evt of events) {
              // Emit using ProtocolEventType directly — no legacy mapping
              const ssePayload: Record<string, unknown> = {
                ...evt.payload,
                runtimeId: evt.source.runtimeId,
                pluginId: evt.source.pluginId,
              };

              await stream.writeSSE({
                data: JSON.stringify(makeEnvelope(evt.type, ssePayload)),
              });
            }

            for (const fp of failedProposals) {
              commitFailureCount += 1;
              await stream.writeSSE({
                data: JSON.stringify(
                  makeEnvelope("proposal.failed", {
                    proposalId: fp.proposal.id,
                    proposalType: fp.proposal.type,
                    runtimeId: fp.proposal.source.runtimeId,
                    pluginId: fp.proposal.source.pluginId,
                    error: fp.error,
                  }),
                ),
              });
            }
          }

          // Commit-derived lifecycle fields and the automatic snapshot belong to
          // the same mutation boundary as execution. The snapshot is deliberately
          // last so it contains every proposal from this turn. `turnCount` syncs
          // unconditionally — it mirrors the turn_results rows that are already
          // persisted, independent of proposal outcomes.
          await syncSessionTurnCount({ store, sessionId, activeRuntimes });

          let snapshotFailed = false;
          if (commitFailureCount === 0) {
            try {
              await saveAutoSnapshot({
                store,
                sessionId,
                turnId,
                createdAt: result.timestamp,
                eventBus,
              });
            } catch (err) {
              snapshotFailed = true;
              console.warn(
                `[actions] auto snapshot failed for session ${sessionId} turn ${turnId}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          } else {
            console.error(
              `[actions] ${commitFailureCount} proposal(s) failed to commit for session ${sessionId} turn ${turnId} — ` +
                "withholding auto-snapshot and turn completion",
            );
          }

          // Commit barrier (audit): the authoritative
          // turn.completed event and post-turn memory ingestion fire ONLY
          // when every proposal committed and the snapshot (if attempted)
          // succeeded. A partial commit or snapshot failure leaves the turn
          // visibly incomplete instead of reporting success over missing
          // state; the player retries or resumes from the last good snapshot.
          if (commitFailureCount === 0 && !snapshotFailed) {
            result.completeTurn?.();
          }

          return { result, trace, userSettings };
        },
      );

      // ——— Post-lock tail ———
      // Deferred-follower scheduling and the final SSE writes deliberately run
      // AFTER the session lock releases: followers acquire the lock themselves
      // (scheduling them under it would start their PG acquire budget while
      // the turn still held the lock), and a slow client draining
      // execution.completed must not extend the critical section.
      const hookPipeline = c.get("hookPipeline");

      // Audit F1 (main turn path): `executeTurn` can surface `deferredFollowers`
      // — event-chain followers with `execution: 'background'` that were
      // skipped so the player gets an immediate response (e.g. scene-stage's
      // background-gen). Schedule them the same way plugin-rpc.ts's sync mode
      // does: a pending `_jobs` row + `setImmediate`, so they actually run
      // instead of silently never firing on the main narrative path.
      if (result.deferredFollowers?.length) {
        const runtimeTurnRunner = createPluginRpcRuntimeTurnRunner({
          store,
          eventBus,
          sessionLock,
          sessionId,
          // effectiveLocale, not session.locale — the in-memory `session` may
          // still hold the pre-update value even though the store write above
          // already persisted the live locale.
          session: { ...session, locale: effectiveLocale },
          activeRuntimes,
          deps: {
            loadRuntime: loadRuntimeFn,
            llm: llmAdapter,
            ...(pluginGateway ? { gateway: pluginGateway } : {}),
            ...(pluginUtils ? { utils: pluginUtils } : {}),
            ...(getPluginSource ? { getPluginSource } : {}),
            ...(mediaStore ? { mediaStore } : {}),
            toolExecutor,
            resolveModel,
            compactor: compactorRunner,
            ...(turnContextBudget
              ? { estimator: estimateTokens, contextBudget: turnContextBudget }
              : {}),
            capabilityPluginIds,
            ...(eventDirectory ? { eventDirectory } : {}),
          },
          ...(hookPipeline ? { hookPipeline } : {}),
        });
        const jobRunner = createPluginRpcJobRunner({
          store,
          sessionId,
          ...(userSettings ? { userSettings } : {}),
          // ponytail: no manual-trigger concept on the main turn path —
          // scheduleDeferredFollowers is the only method this route calls.
          runManualTurn: () => {
            throw new Error("runManualTurn is unused on the main turn path");
          },
          runDeferredFollowerTurn: (args) =>
            runtimeTurnRunner.runDeferredFollowerTurn(args),
          hasActiveRuntime: (runtimeId) =>
            activeRuntimes.some((rt) => rt.name === runtimeId),
        });
        await jobRunner.scheduleDeferredFollowers(result.deferredFollowers);
      }

      // Emit runtime progress: complete + persist trace
      await trace.turnCompleted({
        durationMs: result.durationMs,
        resultCount: result.runtimeResults.length,
      });
      await stream.writeSSE({
        data: JSON.stringify(
          makeEnvelope("execution.completed", {
            runtimeCount: activeRuntimes.length,
            resultCount: result.runtimeResults.length,
            durationMs: result.durationMs,
            // Surface a turn that was aborted before producing output (e.g.
            // cost-gate's hard budget cap) so the player gets a visible reason
            // instead of a silent empty turn.
            ...(result.abortReason ? { abortReason: result.abortReason } : {}),
          }),
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope("error.occurred", { message })),
      });
    } finally {
      releaseTurnControl?.();
      eventBusUnsubscribe?.();
    }
  });
});
