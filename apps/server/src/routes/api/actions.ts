/**
 * Actions route — SSE bridge between frontend action protocol and turn executor.
 *
 * Translates action requests (send_message, execute_command, etc.)
 * into turn execution and streams results back as SSE events.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { LLMAdapter, ToolExecutor, HookPipeline } from '@covel/runtime';
import type { EventBus } from '@covel/events';
import { executeTurn, processRuntimeResult, createTraceRecorder, createTurnEmitter } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';
import type { CompactorRunner } from '@covel/context';
import { rateLimiter } from '../../middleware/rate-limit.js';
import { loadSessionConfig } from './load-session-config.js';

// SSE uses ProtocolEventType names directly — no legacy mapping.
// Frontend handleSseEvent handles these standard types.

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    getConfigFn: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
    resolveModel: (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;
    eventBus: EventBus;
    compactorRunner: CompactorRunner;
    hookPipeline?: HookPipeline;
    memorySystem?: {
      readonly manager: { loadBlocks(sid: string): Promise<readonly { label: string; content: string; updatedAt: string }[]>; initializeDefaults(sid: string): Promise<void> };
      readonly updater: { updateAfterTurn(p: { sessionId: string; narrativeText: string; toolCallSummaries?: readonly string[]; currentBlocks: readonly { label: string; content: string; updatedAt: string }[]; locale?: string }): Promise<{ updated: boolean; blocksChanged: readonly string[]; error?: string }> };
    };
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  };
};

export const actionRoutes = new Hono<Env>();

// Module-level memory system reference, set by bootstrap via setMemorySystem().
// Using a module variable instead of Hono context because Hono's typed
// c.set/c.get doesn't support optional cross-module types cleanly.
let _memorySystem: Env['Variables']['memorySystem'] | undefined;
export function setMemorySystem(ms: Env['Variables']['memorySystem']) {
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

actionRoutes.post('/', rateLimiter({ max: 30 }), async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const llmAdapter = c.get('llmAdapter');
  const loadRuntimeFn = c.get('loadRuntimeFn');
  const toolExecutor = c.get('toolExecutor');
  const getConfigFn = c.get('getConfigFn');
  const resolveModel = c.get('resolveModel');
  const eventBus = c.get('eventBus');
  const compactorRunner = c.get('compactorRunner');
  const sessionLock = c.get('sessionLock');
  const prepareToolsForSession = c.get('prepareToolsForSession');  // optional — see env.d.ts

  const body = await c.req.json<ActionRequest>();
  const { requestId, type, sessionId, locale, model, payload } = body;

  const SUPPORTED_ACTIONS = ['send_message', 'execute_command', 'trigger_event', 'start_session', 'retry_runtime'];
  if (!SUPPORTED_ACTIONS.includes(type)) {
    return c.json({ error: `Unsupported action type: ${type}` }, 400);
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Lazy-lock the session's embedding model once per process boot.
  // No-op when the store has no vector capability or no embed slot is
  // configured. See apps/server/src/embedding-lock.ts for rationale.
  const ensureEmbeddingLock = c.get('ensureEmbeddingLock');
  if (ensureEmbeddingLock) {
    try {
      await ensureEmbeddingLock(sessionId);
    } catch (err) {
      // Don't fail the turn if the lock can't be established —
      // RAG plugins will simply receive an empty vector store.
      // eslint-disable-next-line no-console
      console.warn(
        `[actions] embedding lock failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const playerMessage = type === 'start_session'
    ? '' // First turn has no player message
    : (payload.content as string) ?? (payload.command as string) ?? '';
  const turnId = crypto.randomUUID();

  // Locale: an explicit request.locale (sent by the client on every turn
  // based on the live UI language) wins over the session's stored locale so
  // users who toggle language mid-session see matching LLM output. The
  // session.locale still acts as the fallback when the client omits it.
  const effectiveLocale = locale ?? session.locale ?? 'zh-CN';

  // Ensure session's plugins are activated in the registry (idempotent, needed after server restart).
  // On start_session with no plugins yet, auto-activate all registered plugins and persist.
  let sessionPlugins = session.activePlugins as readonly string[] | undefined;
  if (type === 'start_session' && (!sessionPlugins || sessionPlugins.length === 0)) {
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

  // Build outputKind lookup from manifest declarations (framework never hardcodes plugin IDs).
  // Key = manifest.name, which the executor uses as both runtimeId and pluginId.
  const outputKindMap = new Map<string, string>();
  for (const rt of activeRuntimes) {
    outputKindMap.set(rt.name, rt.outputKind ?? 'plugin');
  }

  // Discover the world data provider plugin by capability (framework never hardcodes plugin IDs)
  const worldDataPluginId = pluginRegistry.findPluginByCapability(sessionId, 'world-data-provider');

  // Pre-load plugin config data for context injection (async → sync bridge)
  const sessionConfig = await loadSessionConfig(store, sessionId, session.worldId ?? undefined, worldDataPluginId);
  const turnGetConfig = (_pluginId: string, _runtimeId: string): Readonly<Record<string, unknown>> => sessionConfig;

  return streamSSE(c, async (stream) => {
    let seq = 0;
    const traceId = crypto.randomUUID();

    function makeEnvelope(eventType: string, eventPayload: Record<string, unknown>) {
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
    const FORWARDED_SUBTYPES = new Set([
      'plugin-data.changed',
      'world.dimensions.changed',
      'turn.suspended',
      'turn.resumed',
    ]);
    const eventBusUnsubscribe = eventBus.onEmit((ev) => {
      if (ev.sessionId !== sessionId) return;
      if (!FORWARDED_SUBTYPES.has(ev.type)) return;
      const payload = { ...(ev.payload as Record<string, unknown>) };
      stream
        .writeSSE({ data: JSON.stringify(makeEnvelope(ev.type, payload)) })
        .catch(() => { /* stream closed, unsubscribe handles cleanup */ });
    });

    try {
      // Persist player message to messages table (source of truth for refresh recovery)
      if (playerMessage) {
        const now = new Date().toISOString();
        await store.addMessage({
          id: crypto.randomUUID(),
          sessionId,
          role: 'user',
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
            source: 'player',
            channel: 'web',
            type: type === 'send_message' ? 'message' : 'rpc-call',
            payload: { content: playerMessage, actionType: type },
            createdAt: now,
          });
        } catch (err) {
          console.warn(
            '[actions] saveInteractionRecord failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Create trace recorder for this turn (persists all lifecycle events to DB)
      const trace = createTraceRecorder(store, sessionId, turnId);

      // Per-turn trace emitter — fans emit() into trace_events + eventBus. Threaded
      // down into ToolCallContext / llm-retry / hooks etc. via executeTurn deps.
      const emitter = createTurnEmitter({
        store,
        eventBus,
        sessionId,
        turnId,
      });

      // NOTE: Session `phase` is no longer a first-class field. The state
      // model is `status + turnCount + preGameCompleted`, so there is no
      // `phase.changed` event to emit here — callers that still care about a
      // coarse "pre-game vs playing" display label derive it from
      // `turnCount === 0` vs `> 0`. See audits/2026-04-21-architecture-code-audit.

      // Emit execution started (protocol: execution.started)
      await trace.turnStarted({ runtimeCount: activeRuntimes.length });
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('execution.started', {
          status: 'executing',
          runtimeCount: activeRuntimes.length,
        })),
      });

      // Refresh the per-session character-tool overrides so create/update-
      // character expose the world's CharacterAttributeSchema directly to
      // the LLM (Phase 2). No-op when the schema isn't yet populated for
      // this session — handlers stay correct on schema-less sessions. The
      // optional-chain keeps tests with hand-built DI middleware working.
      await prepareToolsForSession?.(sessionId);

      // Execute turn through the API pipeline.
      //
      // `sessionLock.withLock` serializes `executeTurn` per sessionId so
      // two concurrent POST /api/actions requests cannot interleave their
      // turnNumber computation, state patches, or auto-snapshots
      // (audit 2026-04-20 finding 1). For PG-backed deployments the lock
      // is backed by `pg_advisory_lock` so mutual exclusion extends across
      // Node pods; memory/sqlite use the in-process chain lock (audit
      // 2026-04-21 F5).
      const result = await sessionLock.withLock(sessionId, () => executeTurn(
        {
          sessionId,
          turnId,
          playerMessage,
          locale: effectiveLocale,
          modelOverride: model,
          // PR-6: snapshot session-level per-runtime slot overrides so the
          // turn executor can consult them when resolving each runtime's
          // model. The session record was loaded above (line ~67).
          ...(session?.runtimeModelOverrides
            ? { runtimeModelOverrides: session.runtimeModelOverrides }
            : {}),
        },
        activeRuntimes,
        {
          loadRuntime: loadRuntimeFn,
          llm: llmAdapter,
          getConfig: turnGetConfig,
          store,
          toolExecutor,
          resolveModel,
          emitter,
          onDelta: async (delta) => {
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('narrative.delta', {
                runtimeId: delta.runtimeId,
                pluginId: delta.pluginId,
                kind: outputKindMap.get(delta.runtimeId) ?? 'plugin',
                delta: delta.textDelta,
              })),
            });
          },
          onRuntimeStart: async (info) => {
            await trace.runtimeStarted({ runtimeId: info.runtimeId, pluginId: info.pluginId, priority: info.priority });
            const kind = outputKindMap.get(info.runtimeId) ?? 'plugin';
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('runtime.started', {
                runtimeId: info.runtimeId,
                pluginId: info.pluginId,
                kind,
                label: info.pluginId + '/' + kind,
              })),
            });
          },
          onRuntimeComplete: async (info) => {
            await trace.runtimeCompleted({ runtimeId: info.runtimeId, pluginId: info.pluginId, status: info.status, durationMs: info.durationMs });
            const eventType =
              info.status === 'failed' ? 'runtime.failed' :
                info.status === 'skipped' ? 'runtime.skipped' :
                  'runtime.completed';
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope(eventType, {
                runtimeId: info.runtimeId,
                pluginId: info.pluginId,
                durationMs: info.durationMs,
                status: info.status,
                ...(info.status === 'failed' && info.error ? { error: info.error } : {}),
              })),
            });
          },
          compactor: compactorRunner,
          memorySystem: _memorySystem,
          // Sprint 1-D: let the turn executor construct a unified
          // SessionContextSnapshot when COVEL_SESSION_CONTEXT=1. Ignored
          // otherwise — legacy scattered loads stay in control.
          worldDataPluginId,
        },
      ));

      // Update session turn count — derive from actual turn results to avoid
      // concurrent read-modify-write races (two parallel turns reading the same
      // stale `session.turnCount` and overwriting each other).
      //
      // Semantic note: `session.turnCount` measures completed turns
      // (including Pre-Game turn 0), which differs from `turnNumber` inside
      // `executeTurn` (which counts PLAYER messages). After the pre-game turn,
      // `session.turnCount === 1` but the next executeTurn's `turnNumber`
      // is still 0 (no player message has been appended yet). The two are
      // intentionally distinct — `turnCount` drives UI labels; `turnNumber`
      // drives trigger math. See turn-executor.ts for the turnNumber formula.
      //
      // Invariant we rely on: `executeTurn` always calls `store.saveTurnResult`
      // before returning, otherwise `listTurnResults` here would miss the
      // current turn and `turnCount` would drift behind. Locked in by
      // tests/turn-executor-turn-result-always-saved.test.ts.
      const turnResults = await store.listTurnResults(sessionId);
      await store.updateSession(sessionId, {
        turnCount: turnResults.length,
        updatedAt: new Date().toISOString(),
      });

      // Process all runtime results through Session Kernel:
      // normalize output → commit to Store → emit SessionEvents as SSE.
      //
      // hookPipeline / eventBus are forwarded so `PreStateCommit` and
      // `PostStateCommit` hooks declared by plugins actually fire on the
      // production write path (previously they only ran in tests).
      const hookPipeline = c.get('hookPipeline');
      for (const rr of result.runtimeResults) {
        const kind = outputKindMap.get(rr.runtimeId) ?? 'plugin';
        const { events } = await processRuntimeResult(rr, store, sessionId, kind, {
          ...(hookPipeline ? { hookPipeline } : {}),
          eventBus,
          emitter,
        });

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

      // Emit runtime progress: complete + persist trace
      await trace.turnCompleted({ durationMs: result.durationMs, resultCount: result.runtimeResults.length });
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('execution.completed', {
          runtimeCount: activeRuntimes.length,
          resultCount: result.runtimeResults.length,
          durationMs: result.durationMs,
        })),
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('error.occurred', { message })),
      });
    } finally {
      eventBusUnsubscribe();
    }
  });
});
