/**
 * HookPipeline — ordered, abort-capable hook execution engine.
 *
 * Semantics:
 * - Global hooks run first; plugin hooks run in declared order after.
 * - Each handler has an individual timeout (default 5000ms).
 * - `continue` → pipeline proceeds; optional `replace` is shallow-merged into payload.
 * - `abort` → pipeline stops immediately. Pre* hooks abort the operation.
 *   Post* hooks' abort is logged only — the operation already completed.
 * - Thrown exceptions are treated as abort with the error message.
 * - All aborts/timeouts/errors emit observability events via the EventBus.
 */

import type { EventBus } from '@covel/events';
import type { HookEvent, HookContext, HookHandler, HookRegistration, HookResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5000;

export class HookPipeline {
  private readonly registrations = new Map<HookEvent, Array<HookRegistration<unknown>>>();

  register<P>(reg: HookRegistration<P>): void {
    const list = this.registrations.get(reg.event) ?? [];
    list.push(reg as HookRegistration<unknown>);
    this.registrations.set(reg.event, list);
  }

  unregister(id: string): void {
    for (const [event, list] of this.registrations) {
      const filtered = list.filter((r) => r.id !== id);
      if (filtered.length !== list.length) {
        this.registrations.set(event, filtered);
      }
    }
  }

  /** Remove all registrations. Primarily for test isolation. */
  clear(): void {
    this.registrations.clear();
  }

  /**
   * Run all handlers registered for `event` in order.
   *
   * Returns the accumulated HookResult. If any handler aborts, the chain
   * stops immediately and returns `{ action: 'abort', reason }`.
   * Otherwise returns `{ action: 'continue' }` with the accumulated `replace`
   * (if any handler contributed patches).
   */
  async run<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    opts?: { readonly eventBus?: EventBus },
  ): Promise<HookResult<P>> {
    const raw = this.registrations.get(event) ?? [];
    if (raw.length === 0) {
      return { action: 'continue' };
    }

    // Spec: global hooks (pluginId === undefined) run before plugin hooks.
    // Use a stable sort: globals first, plugin hooks preserve insertion order.
    const handlers = [...raw].sort((a, b) => {
      const aGlobal = a.pluginId === undefined ? 0 : 1;
      const bGlobal = b.pluginId === undefined ? 0 : 1;
      return aGlobal - bGlobal;
    });

    // Running payload accumulates replace patches from handlers
    let currentPayload: P = payload;
    let hasReplace = false;
    const accumulated: Partial<P> = {};

    for (const reg of handlers) {
      // Apply optional match filter
      if (reg.match && !reg.match(currentPayload)) {
        continue;
      }

      const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const handler = reg.handler as HookHandler<P>;

      let result: HookResult<P>;
      const timeoutMessage = `hook ${reg.id} timed out after ${timeoutMs}ms`;

      try {
        result = await withTimeout(
          handler(ctx, currentPayload),
          timeoutMs,
          timeoutMessage,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const isTimeout = reason === timeoutMessage;
        emitHookEvent(opts?.eventBus, ctx, isTimeout ? 'hook.timeout' : 'hook.error', {
          hookId: reg.id,
          hookPluginId: reg.pluginId,
          reason,
        });
        return { action: 'abort', reason };
      }

      if (result.action === 'abort') {
        emitHookEvent(opts?.eventBus, ctx, 'hook.aborted', {
          hookId: reg.id,
          hookPluginId: reg.pluginId,
          reason: result.reason,
        });
        return result;
      }

      // action === 'continue' — merge optional replace patch
      if ('replace' in result && result.replace !== undefined) {
        Object.assign(accumulated, result.replace);
        hasReplace = true;
        // Apply accumulated patches to the payload for downstream handlers
        currentPayload = { ...currentPayload, ...result.replace };
      }
    }

    if (hasReplace) {
      return { action: 'continue', replace: accumulated };
    }
    return { action: 'continue' };
  }
}

export function createHookPipeline(): HookPipeline {
  return new HookPipeline();
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Race a promise against a timeout.
 * On timeout, rejects with the given `timeoutMessage`.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function emitHookEvent(
  eventBus: EventBus | undefined,
  ctx: HookContext,
  subType: string,
  extra: Record<string, unknown>,
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: crypto.randomUUID(),
    type: 'event',
    topic: 'hooks',
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      _subTopic: 'hooks',
      _subType: subType,
      event: ctx.event,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      // Context identity of the runtime being gated (e.g. the runtime whose
      // tool is being wrapped by PreToolUse). May differ from `hookPluginId`
      // below, which identifies the plugin that REGISTERED this hook.
      pluginId: ctx.pluginId,
      runtimeId: ctx.runtimeId,
      ...extra,
    },
  });
}
