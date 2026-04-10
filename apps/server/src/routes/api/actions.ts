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
import { executeTurn } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';
import { loadSessionConfig } from './load-session-config.js';

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (manifest: RuntimeManifest, locale?: string) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    getConfigFn: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
    resolveModel: (manifest: RuntimeManifest, apiOverride?: string) => string | undefined;
  };
};

export const actionRoutes = new Hono<Env>();

interface ActionRequest {
  requestId: string;
  type: string;
  sessionId: string;
  locale?: string;
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

  const body = await c.req.json<ActionRequest>();
  const { requestId, type, sessionId, locale, payload } = body;

  const SUPPORTED_ACTIONS = ['send_message', 'execute_command', 'trigger_event', 'start_session', 'retry_runtime'];
  if (!SUPPORTED_ACTIONS.includes(type)) {
    return c.json({ error: `Unsupported action type: ${type}` }, 400);
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
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

    try {
      // Emit phase change
      await stream.writeSSE({ data: JSON.stringify(makeEnvelope('phase_change', { phase: 'playing' })) });

      // Emit runtime progress: starting
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('runtime.progress', {
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
              data: JSON.stringify(makeEnvelope('message.delta', {
                runtimeId: delta.runtimeId,
                pluginId: delta.pluginId,
                kind: outputKindMap.get(delta.runtimeId) ?? 'plugin',
                delta: delta.textDelta,
              })),
            });
          },
          onRuntimeStart: async (info) => {
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('runtime.progress', {
                status: 'started',
                runtimeId: info.runtimeId,
                pluginId: info.pluginId,
                label: info.pluginId + '/' + (outputKindMap.get(info.runtimeId) ?? 'plugin'),
              })),
            });
          },
          onRuntimeComplete: async (info) => {
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('runtime.progress', {
                status: 'completed',
                runtimeId: info.runtimeId,
                pluginId: info.pluginId,
                durationMs: info.durationMs,
              })),
            });
          },
        },
      );

      // Update session turn count
      await store.updateSession(sessionId, {
        turnCount: session.turnCount + 1,
        updatedAt: new Date().toISOString(),
      });

      // Emit results as SSE events
      for (const rr of result.runtimeResults) {
        // Extract narrative text — prefer narrativeOutput; skip narrativeTemplate (has {{placeholders}})
        const narrativeOutput =
          (rr.output as Record<string, unknown>)?.narrativeOutput ??
          (rr.output as Record<string, unknown>)?.content ?? '';

        const content = typeof narrativeOutput === 'string' ? narrativeOutput : JSON.stringify(narrativeOutput);

        if (content) {
          // Emit message.completed for each runtime output
          await stream.writeSSE({
            data: JSON.stringify(makeEnvelope('message.completed', {
              messageId: crypto.randomUUID(),
              runtimeId: rr.runtimeId,
              pluginId: rr.pluginId,
              kind: outputKindMap.get(rr.runtimeId) ?? 'plugin',
              content,
            })),
          });
        }

        // Emit state patches from runtime output if present
        const output = rr.output as Record<string, unknown> | null;
        if (output?.statePatches && Array.isArray(output.statePatches)) {
          for (const patch of output.statePatches as Array<Record<string, unknown>>) {
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('state.patch.applied', {
                data: patch,
                runtimeId: rr.runtimeId,
              })),
            });
          }
        }
      }

      // Emit pending inputs as blocks
      if (result.pendingInputs) {
        for (const pi of result.pendingInputs) {
          await stream.writeSSE({
            data: JSON.stringify(makeEnvelope('block.emitted', {
              block: {
                id: crypto.randomUUID(),
                type: pi.interaction?.type === 'form' ? 'interactive_form' : 'interactive_choice',
                data: pi.interaction ?? pi.form,
                meta: { runtimeId: pi.runtimeId, pluginId: pi.pluginId },
              },
            })),
          });
        }
      }

      // Emit runtime progress: complete
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('runtime.progress', {
          status: 'completed',
          runtimeCount: activeRuntimes.length,
          resultCount: result.runtimeResults.length,
          durationMs: result.durationMs,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify(makeEnvelope('error', { message })),
      });
    }
  });
});
