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
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import type { EventBus } from '@covel/events';
import { executeTurn, processRuntimeResult, createTraceRecorder } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';
import type { CompactorRunner } from '@covel/context';
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
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  };
};

export const actionRoutes = new Hono<Env>();

interface ActionRequest {
  requestId: string;
  type: string;
  sessionId: string;
  locale?: string;
  model?: string;
  payload: Record<string, unknown>;
}

actionRoutes.post('/', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const llmAdapter = c.get('llmAdapter');
  const loadRuntimeFn = c.get('loadRuntimeFn');
  const toolExecutor = c.get('toolExecutor');
  const getConfigFn = c.get('getConfigFn');
  const resolveModel = c.get('resolveModel');
  const eventBus = c.get('eventBus');
  const compactorRunner = c.get('compactorRunner');

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
        `[actions] embedding lock failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const playerMessage = type === 'start_session'
    ? '' // First turn has no player message
    : (payload.content as string) ?? (payload.command as string) ?? '';
  const turnId = crypto.randomUUID();

  // Locale: prefer session's stored locale (fixed at creation), fallback to request locale
  const effectiveLocale = session.locale ?? locale ?? 'zh-CN';

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
    const FORWARDED_SUBTYPES = new Set(['plugin-data.changed', 'world.dimensions.changed']);
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

      // NOTE: Removed unconditional `phase.changed { phase: 'playing' }` emit here.
      // It fired on every action regardless of real session phase, overriding
      // sessions still in pre-game / character_creation. Real phase transitions
      // now flow only through phase.transition proposals via processRuntimeResult().
      // See audits/2026-04-12-backend-webv2-framework-audit Finding 4.

      // Emit execution started (protocol: execution.started)
      await trace.turnStarted({ runtimeCount: activeRuntimes.length });
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('execution.started', {
          status: 'executing',
          runtimeCount: activeRuntimes.length,
        })),
      });

      // Execute turn through the API pipeline
      const result = await executeTurn(
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
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('runtime.completed', {
                runtimeId: info.runtimeId,
                pluginId: info.pluginId,
                durationMs: info.durationMs,
              })),
            });
          },
          compactor: compactorRunner,
        },
      );

      // Update session turn count
      await store.updateSession(sessionId, {
        turnCount: session.turnCount + 1,
        updatedAt: new Date().toISOString(),
      });

      // Process all runtime results through Session Kernel:
      // normalize output → commit to Store → emit SessionEvents as SSE
      for (const rr of result.runtimeResults) {
        const kind = outputKindMap.get(rr.runtimeId) ?? 'plugin';
        const events = await processRuntimeResult(rr, store, sessionId, kind);

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
