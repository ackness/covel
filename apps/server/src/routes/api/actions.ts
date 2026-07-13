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

// SSE uses ProtocolEventType names directly — no legacy mapping.
// Frontend handleSseEvent handles these standard types.

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
    getConfigFn: (
      pluginId: string,
      runtimeId: string,
    ) => Readonly<Record<string, unknown>>;
    resolveModel: (
      manifest: RuntimeManifest,
      apiOverride?: string,
    ) => string | undefined;
    eventBus: EventBus;
    compactorRunner: CompactorRunner;
    mediaStore?: MediaStore;
    hookPipeline?: HookPipeline;
    memorySystem?: {
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
    };
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  };
};

export const actionRoutes = new Hono<Env>();

// Module-level memory system reference, set by bootstrap via setMemorySystem().
// Using a module variable instead of Hono context because Hono's typed
// c.set/c.get doesn't support optional cross-module types cleanly.
let _memorySystem: Env["Variables"]["memorySystem"] | undefined;
export function setMemorySystem(ms: Env["Variables"]["memorySystem"]) {
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
  const getConfigFn = c.get("getConfigFn");
  const resolveModel = c.get("resolveModel");
  const eventBus = c.get("eventBus");
  const compactorRunner = c.get("compactorRunner");
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

  const SUPPORTED_ACTIONS = [
    "send_message",
    "execute_command",
    "trigger_event",
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

  // Ensure session's plugins are activated in the registry (idempotent, needed after server restart).
  // On start_session with no plugins yet, auto-activate all registered plugins and persist.
  let sessionPlugins = session.activePlugins as readonly string[] | undefined;
  if (
    type === "start_session" &&
    (!sessionPlugins || sessionPlugins.length === 0)
  ) {
    const allPluginIds = Array.from(pluginRegistry.getAll().keys());
    for (const pid of allPluginIds) {
      pluginRegistry.activate(pid, sessionId);
    }
    await store.updateSession(sessionId, {
      activePlugins: allPluginIds,
      updatedAt: new Date().toISOString(),
    });
    sessionPlugins = allPluginIds;
  } else if (sessionPlugins) {
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
    const eventBusUnsubscribe = eventBus.onEmit((ev) => {
      if (ev.sessionId !== sessionId) return;
      if (!FORWARDED_EVENT_TYPES.has(ev.type as CovelEventType)) return;
      const payload = { ...(ev.payload as Record<string, unknown>) };
      stream
        .writeSSE({ data: JSON.stringify(makeEnvelope(ev.type, payload)) })
        .catch(() => {
          /* stream closed, unsubscribe handles cleanup */
        });
    });

    try {
      const { result, trace, userSettings } = await sessionLock.withLock(
        sessionId,
        async () => {
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

          // Create trace recorder for this turn (persists all lifecycle events to DB)
          const trace = createTraceRecorder(store, sessionId, turnId);

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
              ...(pluginGateway ? { gateway: pluginGateway } : {}),
              ...(pluginUtils ? { utils: pluginUtils } : {}),
              ...(getPluginSource ? { getPluginSource } : {}),
              // bootstrapApi always supplies getConfigFn; default to a no-op so a
              // minimal harness (or any caller that omits it) can't crash the turn
              // executor's `deps.getConfig(...)` call. Preserves the defensiveness
              // the removed /:id/turn route carried.
              getConfig: getConfigFn ?? (() => ({})),
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
          for (const rr of result.runtimeResults) {
            const { events } = await resultProcessor.process(rr);

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
          }

          // Commit-derived lifecycle fields and the automatic snapshot belong to
          // the same mutation boundary as execution. The snapshot is deliberately
          // last so it contains every proposal from this turn.
          await syncSessionTurnCount({ store, sessionId, activeRuntimes });
          try {
            await saveAutoSnapshot({
              store,
              sessionId,
              turnId,
              createdAt: result.timestamp,
              eventBus,
            });
          } catch (err) {
            console.warn(
              `[actions] auto snapshot failed for session ${sessionId} turn ${turnId}:`,
              err instanceof Error ? err.message : String(err),
            );
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
            getConfig: getConfigFn ?? (() => ({})),
            ...(mediaStore ? { mediaStore } : {}),
            toolExecutor,
            resolveModel,
            compactor: compactorRunner,
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
      eventBusUnsubscribe();
    }
  });
});
