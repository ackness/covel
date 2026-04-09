/**
 * V2 Actions route — SSE bridge between frontend action protocol and V2 turn executor.
 *
 * Translates v1-style action requests (send_message, execute_command, etc.)
 * into V2 turn execution and streams results back as SSE events.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DataStore } from '@covel/store';
import type { PluginRegistry, LoadedRuntime } from '@covel/plugin-loader';
import type { LLMAdapter, ToolExecutor } from '@covel/runtime';
import { executeTurn } from '@covel/runtime';
import type { RuntimeManifest } from '@covel/shared';

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (manifest: RuntimeManifest) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    getConfigFn: (pluginId: string, runtimeId: string) => Readonly<Record<string, unknown>>;
    resolveModel: (slotOrModel: string, pluginId?: string) => string;
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

  // Get active runtimes from plugin registry
  const activeRuntimes: RuntimeManifest[] = [];
  for (const [, entry] of pluginRegistry.getAll()) {
    if (entry.manifest) {
      activeRuntimes.push(entry.manifest.manifest);
    }
  }
  activeRuntimes.sort((a, b) => a.priority - b.priority);

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

      // Execute turn through the V2 pipeline
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
          getConfig: getConfigFn ?? (() => ({})),
          store,
          toolExecutor,
          resolveModel,
          onDelta: async (delta) => {
            await stream.writeSSE({
              data: JSON.stringify(makeEnvelope('message.delta', {
                runtimeId: delta.runtimeId,
                pluginId: delta.pluginId,
                kind: delta.pluginId === 'core-narrator' ? 'story' : 'plugin',
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
                label: info.pluginId + '/story',
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
              kind: rr.pluginId === 'core-narrator' ? 'story' : 'plugin',
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
