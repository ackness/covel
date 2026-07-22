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
  finalizeExecution,
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
import { advanceSessionTurnCount, isPreGamePending } from "./turn-count.js";
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

  // `trigger_event` was removed: its payload was never read and no UI
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

  // Owner guard (hosted tiers): actions execute turns and spend tokens
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
    // Released in the finally below so a crashed stream never leaves a
    // stale steer/abort target behind.
    let releaseTurnControl: (() => void) | undefined;
    // Whether this turn's execution artifact had its commitStatus settled.
    // Consulted by the outer catch: an error after the artifact was persisted
    // but before settlement is a known failure, not a crash, so the row must
    // not be left `pending` forever.
    let commitStatusSettled = false;

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

    // Single serial write queue for the SSE connection. The envelope (and its
    // seq) is assigned synchronously at enqueue time and chunks are flushed in
    // that order, so a fire-and-forget event-bus forward can never interleave
    // with — or overtake — an awaited write. The returned promise carries the
    // individual write's outcome (awaiting callers still observe a closed
    // stream as an error); the chain itself swallows failures so one broken
    // write does not wedge every later one.
    let writeChain: Promise<void> = Promise.resolve();
    const writeEvent = (
      eventType: string,
      eventPayload: Record<string, unknown>,
    ): Promise<void> => {
      const data = JSON.stringify(makeEnvelope(eventType, eventPayload));
      const next = writeChain.then(() => stream.writeSSE({ data }));
      writeChain = next.catch(() => {});
      return next;
    };

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
    // The subscription's lifetime is exactly the session-lock tenure: it is
    // established INSIDE the lock (see below) and torn down while the lock is
    // still held. Subscribing before the lock meant a second action queued on
    // the same session received the FIRST action's events while waiting;
    // unsubscribing after release (previously in the outer finally) meant the
    // reverse — once the next action acquired the lock, this stream was still
    // subscribed and wrapped the NEW turn's events in the OLD turnId/traceId
    // envelope. Bus events emitted outside this turn's lock tenure (e.g. by
    // deferred followers scheduled in the post-lock tail) reach clients via
    // the /api/events/stream subscription channel, not this per-turn stream.
    let eventBusUnsubscribe: (() => void) | undefined;
    const subscribeEventForwarding = (): void => {
      eventBusUnsubscribe = eventBus.onEmit((ev) => {
        if (ev.sessionId !== sessionId) return;
        if (!FORWARDED_EVENT_TYPES.has(ev.type as CovelEventType)) return;
        writeEvent(ev.type, {
          ...(ev.payload as Record<string, unknown>),
        }).catch(() => {
          /* stream closed, teardown handles cleanup */
        });
      });
    };

    try {
      const { result, trace, userSettings, committed } =
        await sessionLock.withLock(sessionId, async () => {
          // This execution now owns the session — events on the bus
          // from here on belong to this turn.
          subscribeEventForwarding();
          try {
            // Authoritative gate: re-read the session status under the
            // lock BEFORE any write. A pause/end that raced the pre-stream
            // check must not get player messages, interaction records, or
            // compaction appended to a non-active session. The throw surfaces
            // as an `error.occurred` SSE event via the outer catch.
            const liveSession = await store.getSession(sessionId);
            if (!liveSession) {
              throw new Error(
                "session was deleted while the action was queued",
              );
            }
            if (liveSession.status && liveSession.status !== "active") {
              throw new Error(
                `session is ${liveSession.status}; it must be active to accept actions`,
              );
            }

            // Captured BEFORE the turn runs: the execution may complete
            // Pre-Game itself, and turn accounting must know whether this
            // request started as a setup request (see advanceSessionTurnCount).
            const wasPreGamePending = isPreGamePending(
              activeRuntimes,
              liveSession.preGameCompleted,
            );

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

              // Also emit a normalised InteractionRecord so observability and
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
            // emitter + commit-pipeline rows under one traceId.
            const trace = createTraceRecorder(
              store,
              sessionId,
              turnId,
              traceId,
            );

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

            // Emit execution started (protocol: execution.started). Goes
            // through the serial write queue like every other stream write, so
            // it keeps its envelope order relative to forwarded bus events.
            await trace.turnStarted({ runtimeCount: activeRuntimes.length });
            await writeEvent("execution.started", {
              status: "executing",
              runtimeCount: activeRuntimes.length,
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

            // A scoped retry_runtime (payload.runtimeId set) reruns ONE
            // runtime, not a new player turn. Stamp it non-player origin and
            // keep it out of turnCount so retrying doesn't advance the counter
            // a second time over the same logical turn.
            const isScopedRetry =
              type === "retry_runtime" &&
              typeof payload?.runtimeId === "string" &&
              payload.runtimeId.length > 0;

            const turnInput = {
              sessionId,
              turnId,
              playerMessage,
              locale: effectiveLocale,
              modelOverride: model,
              // Feed the pre-turn Pre-Game snapshot so the executor can fix the
              // execution's countPolicy at creation. Transition field — the
              // kernel derives this itself once the persisted phase lands.
              preGamePending: wasPreGamePending,
              ...(userSettings ? { userSettings } : {}),
              // Snapshot session-level per-runtime slot overrides so the
              // turn executor can consult them when resolving each runtime's
              // model. The session record was loaded above (line ~67).
              ...(session?.runtimeModelOverrides
                ? { runtimeModelOverrides: session.runtimeModelOverrides }
                : {}),
              ...(type === "start_session"
                ? { suppressPlayerMessage: true }
                : {}),
              // retry_runtime honors payload.runtimeId: scope the rerun to
              // that runtime via the manual-trigger path instead of silently
              // re-running the whole turn. Without a runtimeId the action keeps
              // its historical whole-turn-retry semantics.
              ...(isScopedRetry
                ? {
                    manualTrigger: { runtimeId: payload.runtimeId as string },
                    origin: "manual" as const,
                  }
                : {}),
            };
            // Register the in-flight turn only after this action owns the
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
                  await writeEvent("narrative.delta", {
                    runtimeId: delta.runtimeId,
                    pluginId: delta.pluginId,
                    kind: outputKindResolver.getOutputKind(delta.runtimeId),
                    delta: delta.textDelta,
                  });
                },
                onRuntimeStart: async (info) => {
                  await trace.runtimeStarted({
                    runtimeId: info.runtimeId,
                    pluginId: info.pluginId,
                    priority: info.priority,
                  });
                  const kind = outputKindResolver.getOutputKind(info.runtimeId);
                  await writeEvent("runtime.started", {
                    runtimeId: info.runtimeId,
                    pluginId: info.pluginId,
                    kind,
                    label: info.pluginId + "/" + kind,
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
                  await writeEvent(eventType, {
                    runtimeId: info.runtimeId,
                    pluginId: info.pluginId,
                    durationMs: info.durationMs,
                    status: info.status,
                    ...(info.status === "failed" && info.error
                      ? { error: info.error }
                      : {}),
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
                // Player mid-turn steering + abort.
                turnControl: registeredTurn.turnControl,
              });
            } finally {
              registeredTurn.release();
            }

            // Commit the whole execution — top-level plus nested recursiveCall
            // results — in ONE transaction via the shared finalize primitive.
            // Any proposal failure rolls the whole turn back (committed siblings
            // included) and settles the turn_results row to `failed`; a clean
            // run settles it `committed`, both inside that transaction. Nested
            // rows reuse the top-level turnId, so `[turnId]` settles them all.
            //
            // hookPipeline / eventBus are forwarded so `PreStateCommit` and
            // `PostStateCommit` hooks declared by plugins fire on the production
            // write path (previously they only ran in tests).
            const hookPipeline = c.get("hookPipeline");
            const outcome = await finalizeExecution({
              store,
              sessionId,
              ...(result.executionContext
                ? { executionContext: result.executionContext }
                : {}),
              runtimes: activeRuntimes,
              results: [
                ...result.runtimeResults,
                ...(result.nestedRuntimeResults ?? []),
              ],
              turnIds: [turnId],
              ...(hookPipeline ? { hookPipeline } : {}),
              eventBus,
              emitter,
            });
            // finalize owns the commit_status settle (committed or failed).
            commitStatusSettled = true;

            for (const evt of outcome.events) {
              // Emit using ProtocolEventType directly — no legacy mapping.
              await writeEvent(evt.type, {
                ...evt.payload,
                runtimeId: evt.source.runtimeId,
                pluginId: evt.source.pluginId,
              });
            }
            // Commit failures are surfaced as `proposal.failed` SSE events; any
            // failure withholds the completion barrier below (turn.completed,
            // memory ingestion, auto-snapshot success signal).
            for (const fp of outcome.failedProposals) {
              await writeEvent("proposal.failed", {
                proposalId: fp.proposal.id,
                proposalType: fp.proposal.type,
                runtimeId: fp.proposal.source.runtimeId,
                pluginId: fp.proposal.source.pluginId,
                error: fp.error,
              });
            }
            const committed = outcome.status === "committed";

            // Turn accounting and the automatic snapshot share the execution's
            // mutation boundary but stay OUTSIDE the finalize transaction for
            // now (moving turn accounting in is a later wave).
            //
            // Order matters:
            //  1. Advance turnCount only for a fully committed player execution
            //     — the count drives the UI turn display, auto-snapshot cadence,
            //     and snapshot numbering, so a failed commit must not move it.
            //  2. Capture the automatic snapshot last so it contains every
            //     committed proposal AND the turn number it belongs to.
            await advanceSessionTurnCount({
              store,
              sessionId,
              turnId,
              activeRuntimes,
              wasPreGamePending,
              // A scoped retry reruns one runtime over the same logical turn —
              // it must not advance the counter even when its proposals commit.
              committed: committed && !isScopedRetry,
            });

            if (committed) {
              try {
                await saveAutoSnapshot({
                  store,
                  sessionId,
                  turnId,
                  createdAt: result.timestamp,
                  eventBus,
                });
              } catch (err) {
                // Best-effort checkpoint: a failed snapshot is logged but does
                // not fail the turn — the proposals are already durable.
                console.warn(
                  `[actions] auto snapshot failed for session ${sessionId} turn ${turnId}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            } else {
              console.error(
                `[actions] proposal commit failed for session ${sessionId} turn ${turnId} — ` +
                  "withholding auto-snapshot and turn completion",
              );
            }

            // Commit barrier: the authoritative turn.completed event and
            // post-turn memory ingestion fire once every proposal committed.
            // A failed auto-snapshot does NOT hold them back — the business
            // state is already durable (turnCount advanced above on the same
            // proposal-only condition), only the best-effort checkpoint is
            // missing and the next turn snapshots again. Gating completion on
            // the snapshot would strand a fully-committed turn as "incomplete".
            if (committed) {
              result.completeTurn?.();
            }

            return { result, trace, userSettings, committed };
          } finally {
            // Torn down while the lock is still held: after release the next
            // action owns the session, and its events must not be wrapped in
            // this stream's turnId/traceId envelope.
            eventBusUnsubscribe?.();
            eventBusUnsubscribe = undefined;
          }
        });

      // ——— Post-lock tail ———
      // Deferred-follower scheduling and the final SSE writes deliberately run
      // AFTER the session lock releases: followers acquire the lock themselves
      // (scheduling them under it would start their PG acquire budget while
      // the turn still held the lock), and a slow client draining
      // execution.completed must not extend the critical section.
      const hookPipeline = c.get("hookPipeline");

      // Main turn path: `executeTurn` can surface `deferredFollowers`
      // — event-chain followers with `execution: 'background'` that were
      // skipped so the player gets an immediate response (e.g. scene-stage's
      // background-gen). Schedule them the same way plugin-rpc.ts's sync mode
      // does: a pending `_jobs` row + `setImmediate`, so they actually run
      // instead of silently never firing on the main narrative path.
      // Only when this turn's writes actually landed — a follower chained onto
      // a rolled-back turn operates on state that no longer exists.
      if (committed && result.deferredFollowers?.length) {
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
      await writeEvent("execution.completed", {
        runtimeCount: activeRuntimes.length,
        resultCount: result.runtimeResults.length,
        durationMs: result.durationMs,
        // Surface a turn that was aborted before producing output (e.g.
        // cost-gate's hard budget cap) so the player gets a visible reason
        // instead of a silent empty turn.
        ...(result.abortReason ? { abortReason: result.abortReason } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A known failure must not leave the execution artifact `pending` —
      // that state is reserved for crashes. No-op when the turn never
      // persisted a row (error before/inside execution). Best-effort: the
      // stream error event below matters more than this bookkeeping write.
      if (!commitStatusSettled) {
        commitStatusSettled = true;
        await store
          .setTurnResultCommitStatus(sessionId, turnId, "failed")
          .catch(() => {});
      }
      await writeEvent("error.occurred", { message }).catch(() => {});
    } finally {
      releaseTurnControl?.();
      eventBusUnsubscribe?.();
    }
  });
});
