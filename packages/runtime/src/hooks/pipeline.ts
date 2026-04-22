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
    opts?: {
      readonly eventBus?: EventBus;
      readonly emitter?: import('../turn-emitter.js').TurnEmitter;
    },
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

      // Emit `hook.fired` once per invocation attempt — before the handler
      // runs so consumers still see the record even if the handler throws.
      if (opts?.emitter) {
        const proposalType = extractProposalType(event, currentPayload);
        await opts.emitter.emit('hook.fired', {
          event,
          hookName: reg.id,
          pluginId: reg.pluginId ?? null,
          runtimeId: ctx.runtimeId,
          targetId: extractTargetId(event, currentPayload),
          targetType: extractTargetType(event),
          ...(proposalType ? { proposalType } : {}),
        });
      }

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
        if (opts?.emitter) {
          const proposalType = extractProposalType(event, currentPayload);
          await opts.emitter.emit('hook.aborted', {
            event,
            hookName: reg.id,
            pluginId: reg.pluginId ?? null,
            runtimeId: ctx.runtimeId,
            targetId: extractTargetId(event, currentPayload),
            targetType: extractTargetType(event),
            reason: result.reason,
            // Spec schema keeps `proposalType` on hook.aborted. Preserves
            // the field the pre-refactor inline trace write used to carry.
            ...(proposalType ? { proposalType } : {}),
          });
        }
        return result;
      }

      // action === 'continue' — merge optional replace patch
      if ('replace' in result && result.replace !== undefined) {
        if (opts?.emitter) {
          const before = currentPayload;
          const after = { ...currentPayload, ...result.replace };
          const proposalType = extractProposalType(event, currentPayload);
          await opts.emitter.emit('hook.rewrote', {
            event,
            hookName: reg.id,
            pluginId: reg.pluginId ?? null,
            runtimeId: ctx.runtimeId,
            targetId: extractTargetId(event, currentPayload),
            diff: { before, after },
            ...(proposalType ? { proposalType } : {}),
          });
        }
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

/**
 * Extract a target identifier from a hook payload so the `/debug` timeline
 * can cross-link a hook event to the tool call or proposal it guarded.
 * Returns `undefined` when the event has no natural target or the payload
 * is missing the expected fields.
 */
function extractTargetId(event: HookEvent, payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    // Production payload shape is `{ toolCall: { id, name, arguments } }`
    // (built by runPreToolUseHook / runPostToolUseHook in wire-helpers.ts).
    // The field is `id`, not `toolCallId` — `toolCallId` is on ToolCallRecord
    // which never reaches the hook pipeline.
    const toolCall = p.toolCall as Record<string, unknown> | undefined;
    return typeof toolCall?.id === 'string' ? toolCall.id : undefined;
  }
  if (event === 'PreStateCommit' || event === 'PostStateCommit') {
    const proposal = p.proposal as Record<string, unknown> | undefined;
    return typeof proposal?.id === 'string' ? proposal.id : undefined;
  }
  return undefined;
}

/**
 * Map a HookEvent to the domain category of its primary target so trace
 * consumers don't have to re-derive the classification.
 */
function extractTargetType(event: HookEvent): 'proposal' | 'toolCall' | 'turn' {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      return 'toolCall';
    case 'PreStateCommit':
    case 'PostStateCommit':
      return 'proposal';
    case 'TurnStart':
    case 'TurnStop':
    case 'PreRuntime':
    case 'PostRuntime':
    default:
      return 'turn';
  }
}

/**
 * Extract the `proposal.type` from a state-commit hook payload so the
 * `hook.aborted` trace row keeps the `proposalType` field the pre-refactor
 * inline trace write carried. Returns `undefined` for other hook events or
 * when the payload shape is unexpected.
 */
function extractProposalType(event: HookEvent, payload: unknown): string | undefined {
  if (event !== 'PreStateCommit' && event !== 'PostStateCommit') return undefined;
  if (!payload || typeof payload !== 'object') return undefined;
  const proposal = (payload as { proposal?: unknown }).proposal;
  if (!proposal || typeof proposal !== 'object') return undefined;
  const type = (proposal as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
