import { commitExecution } from "./commit-execution.js";
import { resolveMediaImageFlow } from "./media-image-flow.js";
import { listRuntimeJobs } from "./plugin-rpc/jobs.js";
import {
  announceQueuedRuntimeJobs,
  withSettledExecutionLock,
  requestJobServices,
} from "./plugin-rpc/settled-request.js";
/**
 * Actions route — SSE bridge between frontend action protocol and turn executor.
 *
 * Translates action requests (send_message, execute_command, etc.)
 * into turn execution and streams results back as SSE events.
 */

import { Hono } from "hono";
import { streamOwnedSSE } from "../../application-work.js";
import type { DataStore, MediaStore } from "@covel/store";
import type { PluginRegistry, LoadedRuntime } from "@covel/plugin-loader";
import type { LLMAdapter, ToolExecutor, HookPipeline } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import {
  executeTurn,
  createTraceRecorder,
  createTurnEmitter,
  snapshotUserSettings,
} from "@covel/runtime";
import type {
  CovelEventType,
  JobStatusRecord,
  RuntimeManifest,
  RuntimeRetryScope,
  SseEnvelope,
} from "@covel/shared";
import {
  FORWARDED_EVENT_TYPES,
  PLAYER_ABORT_REASON,
  concealedRuntimeIds,
  readRuntimeEnv,
} from "@covel/shared";
import type { CompactorRunner } from "@covel/context";
import {
  errorBody,
  SESSION_BUSY_CODE,
  SESSION_BUSY_MESSAGE,
} from "../../api-error.js";
import { SessionLockTimeoutError } from "../../lib/session-lock.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { type RuntimeJobRecord } from "./plugin-rpc/jobs.js";
import {
  enqueueDeferredRuntimeJobs,
  enqueueEventFollowers,
  type QueuedActivatedRuntimeJob,
} from "./plugin-rpc/runtime-job-enqueue.js";
import { publishRuntimeJobStatusEvent } from "./plugin-rpc/runtime-job-worker.js";
import {
  decodePluginUserSettingsHeader,
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "./plugin-user-settings.js";
import { registerActiveTurn } from "./turn-control.js";
import {
  assertRecoverableTurn,
  recoveryAction,
} from "./actions/execution-recovery.js";
import {
  checkSessionOwner,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";
import { validateActionRequest } from "./actions/request.js";
import { preflightActionApprovals } from "./actions/approval-preflight.js";
import { buildTurnExecutorDeps } from "./turn-execution-deps.js";
import { buildSessionHookScope } from "./session/hook-scope.js";
import {
  prepareRuntimeRetry,
  settleRuntimeRetry,
} from "./actions/runtime-retry.js";

// SSE uses CovelEventType names directly.
// Frontend handleSseEvent handles these standard types.

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (
      manifest: RuntimeManifest,
      locale?: string,
      sessionId?: string,
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

actionRoutes.post("/", rateLimiter({ max: 30 }), async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const eventBus = c.get("eventBus");
  const mediaStore = c.get("mediaStore");
  const prepareToolsForSession = c.get("prepareToolsForSession"); // optional — see env.d.ts
  const runtimeJobWorker = c.get("runtimeJobWorker");

  const rawBody = await c.req.json<unknown>().catch(() => null);
  const bodyResult = validateActionRequest(rawBody);
  if (!bodyResult.ok) {
    return c.json(
      errorBody(bodyResult.error, { code: "invalid_action_request" }),
      400,
    );
  }
  const body = bodyResult.value;
  const { requestId, type, sessionId, locale, model, payload } = body;
  const isRuntimeRetry =
    type === "retry_runtime" || type === "retry_failed_runtimes";

  // Enforce header transport limits before opening the SSE response or doing
  // any session work. Malformed legacy values remain a no-settings request.
  const decodedUserSettings = decodePluginUserSettingsHeader(
    c.req.header("X-Plugin-User-Settings"),
  );
  if (!decodedUserSettings.ok) {
    return c.json(
      errorBody(decodedUserSettings.error, { code: decodedUserSettings.code }),
      decodedUserSettings.status,
    );
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(
      errorBody(`Session not found: ${sessionId}`, {
        code: "session_not_found",
      }),
      404,
    );
  }

  // Owner guard (hosted tiers): actions execute turns and spend tokens
  // on the session's behalf.
  const ownerDenied = checkSessionOwner(c, session);
  if (ownerDenied) return ownerDenied;
  const expectedIncarnation = sessionIncarnationIdentity(session);

  // Fast path: a paused/ended session takes no actions. The
  // authoritative re-check happens under the session lock below (this read is
  // racy), but rejecting here returns a clean 409 before the SSE stream opens.
  if (session.status !== "active") {
    return c.json(
      errorBody(
        `session is ${session.status}; it must be active to accept actions`,
        { code: "session_not_active" },
      ),
      409,
    );
  }

  const approval = preflightActionApprovals(c, session, body);
  if (approval) return approval;

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
    type === "send_message"
      ? payload.content
      : type === "execute_command"
        ? payload.command
        : ""; // start/retry carry no new player message
  const turnId = crypto.randomUUID();

  // Locale: an explicit request.locale (sent by the client on every turn
  // based on the live UI language) wins over the session's stored locale so
  // users who toggle language mid-session see matching LLM output. The
  // session.locale still acts as the fallback when the client omits it.
  const effectiveLocale = locale ?? session.locale;

  // Reconcile the process-local registry from the persisted session snapshot.
  // This is needed after restart and also removes plugins disabled by another
  // request or server instance.
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
        { code: "no_active_plugins" },
      ),
      400,
    );
  }
  // Populated from the authoritative live session after taking the lock. Do
  // not reconcile process-local activations from the stale pre-lock snapshot:
  // a queued request from incarnation A must not overwrite incarnation B's
  // registry before its ABA check rejects.
  let activeRuntimes: readonly RuntimeManifest[] = [];

  return streamOwnedSSE(c, async (stream) => {
    const credentialKeys: import("./plugin-rpc/runtime-job-credentials.js").RuntimeJobCredentialKey[] =
      [];
    let seq = 0;
    const traceId = crypto.randomUUID();
    // The turn currently writing to this stream. The opening-continuation
    // turn (below) reuses the stream under its own fresh turnId.
    let currentTurnId: string = turnId;
    // Released in the finally below so a crashed stream never leaves a
    // stale steer/abort target behind.
    let releaseTurnControl: (() => void) | undefined;
    // Whether this turn's execution artifact had its commitStatus settled.
    // Consulted by the outer catch: an error after the artifact was persisted
    // but before settlement is a known failure, not a crash, so the row must
    // not be left `pending` forever.
    let commitStatusSettled = false;
    let hasStartedTurn = false;
    let currentRetryScope: RuntimeRetryScope | undefined;

    function makeEnvelope(
      eventType: string,
      eventPayload: Record<string, unknown>,
    ): SseEnvelope {
      return {
        type: eventType,
        requestId,
        traceId,
        sessionId,
        turnId: currentTurnId,
        flowId: traceId,
        seq: seq++,
        timestamp: new Date().toISOString(),
        payload: { ...eventPayload, ...currentRetryScope },
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

    // One complete turn: lock → execute → finalize → snapshot → followers.
    // Extracted so the opening continuation below can chain a second turn on
    // the same SSE stream (each turn is its own transaction + lock tenure).
    const runTurnOnce = async (turnArgs: {
      readonly turnId: string;
      readonly playerMessage: string;
      readonly suppressPlayerMessage: boolean;
      readonly origin: "player" | "continuation";
    }) => {
      let turnOrigin = turnArgs.origin;
      currentTurnId = turnArgs.turnId;
      commitStatusSettled = false;
      hasStartedTurn = false;
      currentRetryScope = undefined;
      const readLiveActionSession = async () => {
        c.get("requestWork")?.signal.throwIfAborted();
        const live = await store.getSession(sessionId);
        if (!live)
          throw new Error("session was deleted while the action was queued");
        if (sessionIncarnationIdentity(live) !== expectedIncarnation) {
          throw new Error("session was replaced while the action was queued");
        }
        if (live.status !== "active") {
          throw new Error(
            `session is ${live.status}; it must be active to accept actions`,
          );
        }
        return live;
      };
      const executeCapturedTurn = async () => {
        c.get("requestWork")?.signal.throwIfAborted();
        // This execution now owns the session — events on the bus
        // from here on belong to this turn.
        subscribeEventForwarding();
        try {
          // Authoritative gate: re-read the session status under the
          // lock BEFORE any write. A pause/end that raced the pre-stream
          // check must not get player messages, interaction records, or
          // compaction appended to a non-active session. The throw surfaces
          // as an `error.occurred` SSE event via the outer catch.
          const liveSession = await readLiveActionSession();

          if (turnArgs.origin !== "continuation") {
            const recovery = await assertRecoverableTurn(
              store,
              sessionId,
              payload.recoverFromTurnId,
              { type, payload },
            );
            turnOrigin = recovery?.origin ?? turnOrigin;
          }
          // Prep's editable world document is browser-local until the first
          // start action. Persist its value on the session so setup, opening
          // continuation, later turns, reconnects, and other server workers
          // all build context from the same lore.
          pluginRegistry.syncSessionActivations(
            sessionId,
            liveSession.activePlugins,
          );
          activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
          const retryPlan =
            body.type === "retry_runtime" ||
            body.type === "retry_failed_runtimes"
              ? await prepareRuntimeRetry(
                  store,
                  sessionId,
                  body,
                  activeRuntimes,
                )
              : undefined;
          currentRetryScope = retryPlan?.scope;
          const registeredTurn = registerActiveTurn(
            sessionId,
            turnArgs.turnId,
            requestId,
          );
          releaseTurnControl = registeredTurn.release;
          const executionSignal = c.get("requestWork")?.signal;
          const turnControl = {
            ...registeredTurn.turnControl,
            ...(executionSignal ? { executionSignal } : {}),
          };
          const commitSignal = executionSignal
            ? AbortSignal.any([
                registeredTurn.turnControl.signal!,
                executionSignal,
              ])
            : registeredTurn.turnControl.signal;
          commitSignal?.throwIfAborted();
          // Progress display metadata follows the live manifests for this run.
          const outputKindByRuntime = new Map(
            activeRuntimes.map((runtime) => [
              runtime.name,
              runtime.outputKind ?? "plugin",
            ]),
          );

          let effectiveSession = liveSession;
          if (effectiveSession.locale !== effectiveLocale) {
            const updatedAt = new Date().toISOString();
            await store.updateSession(sessionId, {
              locale: effectiveLocale,
              updatedAt,
            });
            effectiveSession = {
              ...effectiveSession,
              locale: effectiveLocale,
              updatedAt,
            };
          }
          if (
            type === "start_session" &&
            payload.loreOverride !== undefined &&
            effectiveSession.metadata?.loreOverride !== payload.loreOverride
          ) {
            const updatedAt = new Date().toISOString();
            const metadata = {
              ...effectiveSession.metadata,
              loreOverride: payload.loreOverride,
            };
            await store.updateSession(sessionId, { metadata, updatedAt });
            effectiveSession = {
              ...effectiveSession,
              metadata,
              updatedAt,
            };
          }

          const wasPreGamePending = effectiveSession.phase === "setup";

          // Commit the REST message mirror and interaction row with proposals
          // and the TurnMessage journal. Rollback removes new mirror rows and
          // turn attachments, preserving any uploaded browser input intent.
          const playerInputCreatedAt = new Date().toISOString();
          const playerInputWrites = turnArgs.playerMessage
            ? {
                message: {
                  id:
                    (type === "send_message" || type === "execute_command"
                      ? payload.inputMessageId
                      : undefined) ?? crypto.randomUUID(),
                  sessionId,
                  role: "user" as const,
                  content: turnArgs.playerMessage,
                  metadata: { turnId: turnArgs.turnId },
                  createdAt: playerInputCreatedAt,
                },
                interaction: {
                  id: crypto.randomUUID(),
                  sessionId,
                  turnId: turnArgs.turnId,
                  timestamp: playerInputCreatedAt,
                  source: "player" as const,
                  channel: "web" as const,
                  type:
                    type === "send_message"
                      ? ("message" as const)
                      : ("rpc-call" as const),
                  payload: {
                    content: turnArgs.playerMessage,
                    actionType: type,
                  },
                  createdAt: playerInputCreatedAt,
                },
              }
            : undefined;

          // Create trace recorder for this turn (persists all lifecycle events
          // to DB). Carries the SSE traceId so recorder rows correlate with
          // emitter + commit-pipeline rows under one traceId.
          const trace = createTraceRecorder(
            store,
            sessionId,
            turnArgs.turnId,
            traceId,
            currentRetryScope,
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
            turnId: turnArgs.turnId,
            traceId,
            retryScope: currentRetryScope,
            concealedRuntimeIds: concealedRuntimeIds(activeRuntimes),
          });

          // `phase` is persisted by the session-clock write in finalizeExecution.
          // There is no standalone `phase.changed` event; clients receive the
          // committed session state through normal snapshot/session refreshes.

          // Emit execution started (protocol: execution.started). Goes
          // through the serial write queue like every other stream write, so
          // it keeps its envelope order relative to forwarded bus events.
          await trace.turnStarted({
            runtimeCount: activeRuntimes.length,
            requestId,
            origin: turnOrigin,
            recoveryAction: recoveryAction(
              type,
              payload,
              turnOrigin === "continuation",
            ),
          });
          hasStartedTurn = true;
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
            ? await store.getWorld(session.worldId)
            : null;
          const userSettings = snapshotUserSettings(
            mergePluginUserSettings(
              readWorldPluginSettings(world?.metadata),
              decodedUserSettings.settings,
            ),
          );

          const hookScope = buildSessionHookScope({
            pluginRegistry,
            activePluginIds: effectiveSession.activePlugins,
            userSettings,
          });

          const turnInput = {
            sessionId,
            turnId: turnArgs.turnId,
            playerMessage: turnArgs.playerMessage,
            locale: effectiveLocale,
            modelOverride: model,
            origin: isRuntimeRetry ? ("manual" as const) : turnOrigin,
            ...(turnOrigin === "player" && !isRuntimeRetry
              ? { logicalTurnId: crypto.randomUUID() }
              : {}),
            userSettings,
            // Snapshot session-level per-runtime slot overrides so the
            // turn executor can consult them when resolving each runtime's
            // model. Read from the record loaded under the lock, so an edit
            // made while this request queued is honoured.
            ...(effectiveSession.runtimeModelOverrides
              ? {
                  runtimeModelOverrides: effectiveSession.runtimeModelOverrides,
                }
              : {}),
            ...(turnArgs.suppressPlayerMessage
              ? { suppressPlayerMessage: true }
              : {}),
            // Scoped retries share one execution and commit without counting
            // another player turn. Seeds are already checked under the lock.
            ...(type === "retry_runtime" || type === "retry_failed_runtimes"
              ? {
                  manualTrigger: {
                    ...(type === "retry_failed_runtimes"
                      ? { runtimeIds: payload.runtimeIds }
                      : { runtimeId: payload.runtimeId }),
                    ...(currentRetryScope
                      ? { sourceTurnId: currentRetryScope.sourceTurnId }
                      : {}),
                    retrySeedResults: retryPlan?.seedResults,
                  },
                }
              : {}),
          };
          // Control covers preparation, execution and commit. Closing the SSE
          // transport does not cancel this turn; a refreshed client observes
          // it through the read-only execution endpoint until finalization.
          const execution = await executeTurn(turnInput, activeRuntimes, {
            ...buildTurnExecutorDeps(c),
            hookScope,
            // The main turn path never passed the eventBus, so every
            // `emitSubEvent` inside the executor — including the
            // completion barrier's `turn.completed` — silently no-opped on
            // the player-facing path (found while adding the
            // fault-injection tests). Without it the barrier's only
            // observable effect was memory ingestion.
            eventBus,
            store,
            emitter,
            onDelta: async (delta) => {
              await writeEvent("narrative.delta", {
                runtimeId: delta.runtimeId,
                pluginId: delta.pluginId,
                kind: outputKindByRuntime.get(delta.runtimeId) ?? "plugin",
                delta: delta.textDelta,
                ...(delta.reset ? { reset: true } : {}),
              });
            },
            onRuntimeStart: async (info) => {
              try {
                await trace.runtimeStarted(info);
              } finally {
                const kind =
                  outputKindByRuntime.get(info.runtimeId) ?? "plugin";
                await writeEvent("runtime.started", {
                  ...info,
                  kind,
                  label: info.pluginId + "/" + kind,
                });
              }
            },
            onRuntimeComplete: async (info) => {
              try {
                if (info.status === "failed") {
                  await trace.runtimeFailed({
                    ...info,
                    error: info.error ?? "Runtime failed",
                  });
                } else {
                  await trace.runtimeCompleted(info);
                }
              } finally {
                const eventType =
                  info.status === "failed"
                    ? "runtime.failed"
                    : info.status === "skipped"
                      ? "runtime.skipped"
                      : "runtime.completed";
                await writeEvent(eventType, { ...info });
              }
            },
            // Player mid-turn steering + abort.
            turnControl,
          });

          const { result } = execution;
          const hookPipeline = c.get("hookPipeline");
          const queuedRuntimeJobs: Array<{
            readonly job: RuntimeJobRecord;
            readonly status: JobStatusRecord;
          }> = [];
          const followerJobs: QueuedActivatedRuntimeJob[] = [];
          const outcome = await commitExecution({
            memorySystem: c.get("memorySystem"),
            imageFlowRuntimeIds: (
              await resolveMediaImageFlow(
                store,
                c.get("pluginExtensions"),
                sessionId,
              )
            )?.assetRuntimeIds,
            completion: {
              kind: "turn",
              turnId: result.turnId,
              durationMs: result.durationMs,
            },
            onFinalized: async (outcome) => {
              commitStatusSettled = true;
              for (const evt of outcome.events) {
                // Emit using CovelEventType directly.
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
            },
            signal: commitSignal,
            store,
            execution,
            ...(playerInputWrites ||
            result.deferredRuntimeJobs?.length ||
            result.deferredFollowers?.length
              ? {
                  extraInTx: async (tx) => {
                    if (playerInputWrites) {
                      await tx.commitPlayerInputMessage(
                        playerInputWrites.message,
                      );
                      await tx.saveInteractionRecord(
                        playerInputWrites.interaction,
                      );
                    }
                    queuedRuntimeJobs.push(
                      ...(await enqueueDeferredRuntimeJobs(tx, {
                        sessionId,
                        session: effectiveSession,
                        activeRuntimes,
                        descriptors: result.deferredRuntimeJobs ?? [],
                        locale: effectiveLocale,
                        ...(model ? { modelOverride: model } : {}),
                        ...(userSettings ? { userSettings } : {}),
                        registerCredentials: (credentialKey, maxQueueMs) => {
                          const services = requestJobServices(c);
                          if (!services) return;
                          c.get("runtimeJobCredentials")?.register(
                            credentialKey,
                            services,
                            maxQueueMs,
                          );
                          credentialKeys.push(credentialKey);
                        },
                      })),
                    );
                    // Background followers (e.g. scene-stage's background-gen)
                    // are queued with the writes they react to, so a
                    // rolled-back turn queues none.
                    followerJobs.push(
                      ...(await enqueueEventFollowers(tx, {
                        sessionId,
                        activeRuntimes,
                        followers: result.deferredFollowers ?? [],
                        sourceTurnId: result.turnId,
                        locale: effectiveLocale,
                        ...(userSettings ? { userSettings } : {}),
                      })),
                    );
                  },
                }
              : {}),
            ...(hookPipeline ? { hookPipeline } : {}),
            eventBus,
            emitter,
            // MediaRef canonicalization / ownership for published export values.
            ...(mediaStore ? { mediaStore } : {}),
          });
          const committed = outcome.status === "committed";
          currentRetryScope = settleRuntimeRetry(
            retryPlan,
            result.runtimeResults,
            committed,
          );
          const proposalErrors = outcome.failedProposals
            .map((failure) => failure.error)
            .filter(Boolean)
            .join("; ");
          const commitError = committed
            ? undefined
            : outcome.error || proposalErrors || "Execution commit failed";

          return {
            result:
              !committed && registeredTurn.turnControl.signal?.aborted
                ? { ...result, abortReason: PLAYER_ABORT_REASON }
                : result,
            trace,
            committed,
            commitError,
            wasPreGamePending,
            queuedRuntimeJobs: committed ? queuedRuntimeJobs : [],
            followerJobs: committed ? followerJobs : [],
          };
        } finally {
          // Torn down while the lock is still held: after release the next
          // action owns the session, and its events must not be wrapped in
          // this stream's turnId/traceId envelope.
          eventBusUnsubscribe?.();
          eventBusUnsubscribe = undefined;
        }
      };
      const {
        result,
        trace,
        committed,
        commitError,
        wasPreGamePending,
        queuedRuntimeJobs,
        followerJobs,
      } = await withSettledExecutionLock(
        c,
        sessionId,
        executeCapturedTurn,
        undefined,
        effectiveLocale,
      );

      // ——— Post-lock tail (per turn) ———
      // Job announcements and the final SSE writes deliberately run AFTER the
      // session lock releases: a slow client draining execution.completed must
      // not extend the critical section.

      for (const queued of queuedRuntimeJobs) {
        publishRuntimeJobStatusEvent(eventBus, queued.status);
        const payload = {
          runtimeId: queued.job.runtimeId,
          pluginId: queued.job.pluginId,
          jobId: queued.job.jobId,
          sourceTurnId: queued.job.origin.sourceTurnId,
        };
        await writeEvent("runtime.deferred", payload);
        eventBus.emit({
          id: crypto.randomUUID(),
          type: "event",
          topic: "runtime",
          sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            ...payload,
            _subTopic: "runtime",
            _subType: "runtime.deferred",
          },
        });
      }
      if (queuedRuntimeJobs.length > 0) runtimeJobWorker?.wake();

      announceQueuedRuntimeJobs(c, followerJobs);

      // Emit runtime progress: complete + persist trace
      await trace.turnCompleted(
        {
          durationMs: result.durationMs,
          resultCount: result.runtimeResults.length,
          committed,
          ...(result.abortReason ? { abortReason: result.abortReason } : {}),
        },
        currentRetryScope,
      );

      return { result, committed, commitError, wasPreGamePending };
    };

    try {
      const first = await runTurnOnce({
        turnId,
        playerMessage,
        suppressPlayerMessage: type === "start_session",
        origin: "player",
      });
      let finalRun = first;

      // Opening continuation: a request that completes the LAST setup runtime
      // commits on its own (turn-wide transaction discipline), so the narrator
      // never ran for this request. Chain exactly one main-loop turn — a
      // second transaction reading the just-committed setup state — so the
      // player gets the opening narrative without having to send another
      // message. Guarded to player actions (both retry actions keep rerun-only
      // semantics) and skipped when the turn aborted or setup is still pending
      // (more setup interactions to come).
      if (
        first.committed &&
        first.wasPreGamePending &&
        !first.result.abortReason &&
        !isRuntimeRetry &&
        type !== "retry_turn"
      ) {
        const settled = await store.getSession(sessionId);
        if (
          settled &&
          settled.status === "active" &&
          settled.phase === "playing"
        ) {
          finalRun = await runTurnOnce({
            turnId: crypto.randomUUID(),
            playerMessage: "",
            suppressPlayerMessage: true,
            origin: "continuation",
          });
        }
      }

      await writeEvent("execution.completed", {
        runtimeCount: activeRuntimes.length,
        resultCount: finalRun.result.runtimeResults.length,
        durationMs: finalRun.result.durationMs,
        committed: finalRun.committed,
        ...(finalRun.commitError ? { error: finalRun.commitError } : {}),
        // Surface a turn that was aborted before producing output (e.g.
        // cost-gate's hard budget cap) so the player gets a visible reason
        // instead of a silent empty turn.
        ...(finalRun.result.abortReason
          ? { abortReason: finalRun.result.abortReason }
          : {}),
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
          .setTurnResultCommitStatus(sessionId, currentTurnId, "failed")
          .catch(() => {});
      }
      if (hasStartedTurn) {
        await store
          .addTraceEvent({
            id: crypto.randomUUID(),
            sessionId,
            turnId: currentTurnId,
            traceId,
            type: "turn.failed",
            payload: { error: message, requestId, ...currentRetryScope },
            createdAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      // This stream is already open (HTTP 200), so the global error
      // handler's coded 503 mapping cannot apply — replicate its wire
      // semantics here. Raw error text can carry internals (the PG lock
      // timeout names the session id and lock-pool hints; store/driver
      // failures carry paths or SQL fragments), so a lost lock race goes out
      // as the same fixed message + `session_busy` code the JSON path uses,
      // and every other error only carries the raw message in dev. Full
      // detail stays in the server log and, for a started turn, in the
      // `turn.failed` trace event above.
      const lockBusy = err instanceof SessionLockTimeoutError;
      if (lockBusy) {
        console.warn(
          `[actions] session lock timeout for ${sessionId}: ${message}`,
        );
      } else {
        console.error(
          `[actions] turn failed for ${sessionId}: ${message}`,
          err,
        );
      }
      const isDev = readRuntimeEnv().nodeEnv !== "production";
      await writeEvent(
        "error.occurred",
        lockBusy
          ? { message: SESSION_BUSY_MESSAGE, code: SESSION_BUSY_CODE }
          : { message: isDev ? message : "Internal server error" },
      ).catch(() => {});
    } finally {
      releaseTurnControl?.();
      eventBusUnsubscribe?.();
      try {
        if (credentialKeys.length > 0) {
          const queuedIds = new Set(
            (await listRuntimeJobs(store, { sessionId }))
              .filter((job) => job.status === "queued")
              .map((job) => job.jobId),
          );
          for (const key of credentialKeys)
            if (!queuedIds.has(key.jobId))
              c.get("runtimeJobCredentials")?.discard(key);
        }
      } catch (error) {
        // A transient read failure must not leak the turn lock. Handoffs have a TTL.
        console.warn("[actions] credential handoff cleanup failed", error);
      }
      await writeChain;
    }
  });
});
