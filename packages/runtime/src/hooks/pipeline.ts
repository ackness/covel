/**
 * HookPipeline — semantic hook execution engine.
 *
 * Semantics:
 * - Hook events run with their declared semantic in HOOK_SEMANTICS.
 * - enforce groups run pre → normal → post.
 * - Inside each enforce group, global hooks run first; plugin hooks keep declared order after.
 * - Each handler has an individual timeout (default 5000ms).
 * - Thrown exceptions are treated as abort with the error message.
 * - All aborts/timeouts/errors emit observability events via the EventBus.
 */

import { invokeWithSignal } from "./invoke-with-signal.js";
import { cloneHookData } from "./hook-data.js";
import { z } from "zod";
import type { EventBus } from "@covel/events";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { HOOK_SEMANTICS } from "./types.js";
import {
  currentActivePluginIds,
  currentOwnSettings,
  isHookInScope,
  isHookScopeActive,
} from "./hook-scope.js";
import type {
  HookEvent,
  HookContext,
  HookHandler,
  HookRegistration,
  HookResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const ENFORCE_ORDER = { pre: 0, normal: 1, post: 2 } as const;
const hookResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("continue"),
    replace: z
      .custom<Record<string, unknown>>((value) => {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
      })
      .optional(),
  }),
  z.object({ action: z.literal("abort"), reason: z.string() }),
]);

interface HookPipelineRunOptions {
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
}

export class HookPipeline {
  private readonly registrations = new Map<
    HookEvent,
    Array<HookRegistration<unknown>>
  >();

  register<P>(reg: HookRegistration<P>): () => void {
    const list = this.registrations.get(reg.event) ?? [];
    const entry = { ...reg } as HookRegistration<unknown>;
    list.push(entry);
    this.registrations.set(reg.event, list);
    return () => {
      const current = this.registrations.get(reg.event);
      if (current) {
        this.registrations.set(
          reg.event,
          current.filter((item) => item !== entry),
        );
      }
    };
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

  /** Host diagnostics expose identities only, never handlers or predicates. */
  list(): readonly { id: string; event: HookEvent; pluginId?: string }[] {
    return [...this.registrations.values()].flatMap((entries) =>
      entries.map(({ id, event, pluginId }) => ({ id, event, pluginId })),
    );
  }

  /**
   * Run all handlers registered for `event` with the event's semantic.
   * Sequential hooks can return accumulated `replace` or `abort`;
   * parallel hooks record handler results and return `continue`.
   */
  async run<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    opts?: HookPipelineRunOptions,
  ): Promise<HookResult<P>> {
    const raw = this.registrations.get(event) ?? [];
    if (raw.length === 0) {
      return { action: "continue" };
    }

    // Session scope: a plugin's hooks fire only for sessions where the plugin
    // is active (framework hooks always fire). No active scope → run all.
    const active = currentActivePluginIds();
    const scoped = raw.filter((reg) => isHookInScope(reg.pluginId, active));
    if (scoped.length === 0) {
      return { action: "continue" };
    }
    const ctxScoped: HookContext =
      active === undefined ? ctx : { ...ctx, activePluginIds: active };

    const handlers = orderHandlers(scoped);
    const semantic = HOOK_SEMANTICS[event];
    let ownedPayload: P;
    try {
      ownedPayload = cloneHookData(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Invalid data must not bypass policy hooks or turn an observer failure
      // into a failure of an already committed operation.
      for (const reg of semantic === "parallel"
        ? handlers
        : handlers.slice(0, 1)) {
        emitHookEvent(opts?.eventBus, ctxScoped, "hook.error", {
          hookId: reg.id,
          hookPluginId: reg.pluginId,
          reason,
        });
      }
      return semantic === "parallel"
        ? { action: "continue" }
        : { action: "abort", reason };
    }

    if (semantic === "first") {
      return this.runFirst(event, ctxScoped, ownedPayload, handlers, opts);
    }
    if (semantic === "sequential") {
      return this.runSequential(event, ctxScoped, ownedPayload, handlers, opts);
    }
    if (semantic === "parallel") {
      return this.runParallel(event, ctxScoped, ownedPayload, handlers, opts);
    }

    // Stream hooks share sequential behavior until a stream transform hook is added.
    return this.runSequential(event, ctxScoped, ownedPayload, handlers, opts);
  }

  private async runFirst<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    handlers: readonly HookRegistration<unknown>[],
    opts?: HookPipelineRunOptions,
  ): Promise<HookResult<P>> {
    for (const reg of handlers) {
      const result = await this.invokeHandler(event, ctx, payload, reg, opts);
      if (result.action === "abort") {
        return result;
      }
      if ("replace" in result && result.replace !== undefined) {
        return result;
      }
    }
    return { action: "continue" };
  }

  private async runSequential<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    handlers: readonly HookRegistration<unknown>[],
    opts?: HookPipelineRunOptions,
  ): Promise<HookResult<P>> {
    let currentPayload: P = payload;
    let hasReplace = false;
    const accumulated: Partial<P> = {};

    for (const reg of handlers) {
      const result = await this.invokeHandler(
        event,
        ctx,
        currentPayload,
        reg,
        opts,
      );

      if (result.action === "abort") {
        return result;
      }

      if ("replace" in result && result.replace !== undefined) {
        Object.assign(accumulated, result.replace);
        hasReplace = true;
        currentPayload = { ...currentPayload, ...result.replace };
      }
    }

    if (hasReplace) {
      return { action: "continue", replace: accumulated };
    }
    return { action: "continue" };
  }

  private async runParallel<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    handlers: readonly HookRegistration<unknown>[],
    opts?: HookPipelineRunOptions,
  ): Promise<HookResult<P>> {
    const settled = await Promise.allSettled(
      handlers.map((reg) => this.invokeHandler(event, ctx, payload, reg, opts)),
    );

    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      if (item.status === "rejected") {
        const reg = handlers[i];
        const reason =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        emitHookEvent(opts?.eventBus, ctx, "hook.error", {
          hookId: reg.id,
          hookPluginId: reg.pluginId,
          reason,
        });
      }
    }

    return { action: "continue" };
  }

  private async invokeHandler<P>(
    event: HookEvent,
    ctx: HookContext,
    payload: P,
    reg: HookRegistration<unknown>,
    opts?: HookPipelineRunOptions,
  ): Promise<HookResult<P>> {
    const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const handler = reg.handler as HookHandler<P>;

    let result: HookResult<P>;
    const timeoutMessage = `hook ${reg.id} timed out after ${timeoutMs}ms`;

    // Inject a read-only, per-plugin settings accessor bound to *this* handler's
    // plugin, reusing the same session hook scope that carries activePluginIds.
    // Only attached when a scope is active — mirrors the run()-level ctxScoped
    // gate. Scope-less calls still receive the per-handler cancellation signal.
    // Framework hooks (no pluginId) get a getter returning `{}`.
    const ownSettings = currentOwnSettings(reg.pluginId);
    const ctxForHandler: HookContext = {
      ...ctx,
      // A supplied activation set needs isolation even without an ambient scope.
      ...(ctx.activePluginIds
        ? { activePluginIds: new Set(ctx.activePluginIds) }
        : {}),
      ...(isHookScopeActive() ? { getOwnSettings: () => ownSettings } : {}),
    };

    try {
      // Filters are plugin code too: failures follow this event's abort or
      // observe-only semantics and retain the registering hook's identity.
      if (reg.match && !reg.match(cloneHookData(payload)))
        return { action: "continue" };

      // Emit `hook.fired` once per invocation attempt, before the handler runs.
      if (opts?.emitter) {
        const proposalType = extractProposalType(event, payload);
        await emitHookTrace(opts.emitter, ctx, reg, "hook.fired", {
          event,
          hookName: reg.id,
          pluginId: reg.pluginId ?? null,
          runtimeId: ctx.runtimeId,
          targetId: extractTargetId(event, payload),
          targetType: extractTargetType(event),
          ...(proposalType ? { proposalType } : {}),
        });
      }

      result = await invokeWithSignal(
        async (signal) => {
          const returned = await handler(
            { ...ctxForHandler, signal },
            cloneHookData(payload),
          );
          signal.throwIfAborted();
          // Take ownership before trace awaits or the next handler can yield.
          const owned = cloneHookData(returned);
          if (!hookResultSchema.safeParse(owned).success) {
            // Do not include untrusted return values in diagnostic errors.
            throw new TypeError("Hook handler returned an invalid result");
          }
          // Keep the owned data: schema output can drop execution artifacts.
          return owned;
        },
        ctx.signal,
        timeoutMs,
        timeoutMessage,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isTimeout = reason === timeoutMessage;
      emitHookEvent(
        opts?.eventBus,
        ctx,
        isTimeout ? "hook.timeout" : "hook.error",
        {
          hookId: reg.id,
          hookPluginId: reg.pluginId,
          reason,
        },
      );
      return { action: "abort", reason };
    }

    if (result.action === "abort") {
      emitHookEvent(opts?.eventBus, ctx, "hook.aborted", {
        hookId: reg.id,
        hookPluginId: reg.pluginId,
        reason: result.reason,
      });
      if (opts?.emitter) {
        const proposalType = extractProposalType(event, payload);
        await emitHookTrace(opts.emitter, ctx, reg, "hook.aborted", {
          event,
          hookName: reg.id,
          pluginId: reg.pluginId ?? null,
          runtimeId: ctx.runtimeId,
          targetId: extractTargetId(event, payload),
          targetType: extractTargetType(event),
          reason: result.reason,
          // Spec schema keeps `proposalType` on hook.aborted. Preserves
          // the field the pre-refactor inline trace write used to carry.
          ...(proposalType ? { proposalType } : {}),
        });
      }
      return result;
    }

    if ("replace" in result && result.replace !== undefined && opts?.emitter) {
      const before = payload;
      const after = { ...payload, ...result.replace };
      const proposalType = extractProposalType(event, payload);
      await emitHookTrace(opts.emitter, ctx, reg, "hook.rewrote", {
        event,
        hookName: reg.id,
        pluginId: reg.pluginId ?? null,
        runtimeId: ctx.runtimeId,
        targetId: extractTargetId(event, payload),
        diff: cloneHookData({ before, after }),
        ...(proposalType ? { proposalType } : {}),
      });
    }

    return result;
  }
}

export function createHookPipeline(): HookPipeline {
  return new HookPipeline();
}

// ── Helpers ──────────────────────────────────────────────────────

function orderHandlers(
  handlers: readonly HookRegistration<unknown>[],
): HookRegistration<unknown>[] {
  return handlers
    .map((reg, index) => ({ reg, index }))
    .sort((a, b) => {
      const enforceDiff =
        ENFORCE_ORDER[a.reg.enforce ?? "normal"] -
        ENFORCE_ORDER[b.reg.enforce ?? "normal"];
      if (enforceDiff !== 0) return enforceDiff;

      const globalDiff =
        (a.reg.pluginId === undefined ? 0 : 1) -
        (b.reg.pluginId === undefined ? 0 : 1);
      if (globalDiff !== 0) return globalDiff;

      return a.index - b.index;
    })
    .map(({ reg }) => reg);
}

function emitHookEvent(
  eventBus: EventBus | undefined,
  ctx: HookContext,
  subType: string,
  extra: { hookId: string; hookPluginId?: string; reason: string },
): void {
  if (!eventBus) return;
  try {
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "hooks",
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        _subTopic: "hooks",
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
  } catch {
    console.warn("[hook-pipeline] event delivery failed", {
      type: subType,
      event: ctx.event,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      runtimeId: ctx.runtimeId,
      hookId: extra.hookId,
      hookPluginId: extra.hookPluginId,
    });
  }
}

/** Diagnostic failures cannot skip a policy or change its accepted result. */
async function emitHookTrace(
  emitter: TurnEmitter,
  ctx: HookContext,
  reg: Pick<HookRegistration, "id" | "pluginId">,
  type: "hook.fired" | "hook.aborted" | "hook.rewrote",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitter.emit(type, payload);
  } catch {
    // Error text and trace payloads can contain credentials or player content.
    console.warn("[hook-pipeline] trace delivery failed", {
      type,
      event: ctx.event,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      traceId: emitter.traceId,
      runtimeId: ctx.runtimeId,
      hookId: reg.id,
      hookPluginId: reg.pluginId,
    });
  }
}

/**
 * Extract a target identifier from a hook payload so the `/debug` timeline
 * can cross-link a hook event to the tool call or proposal it guarded.
 * Returns `undefined` when the event has no natural target or the payload
 * is missing the expected fields.
 */
function extractTargetId(
  event: HookEvent,
  payload: unknown,
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (event === "PreToolUse" || event === "PostToolUse") {
    // Production payload shape is `{ toolCall: { id, name, arguments } }`
    // (built by runPreToolUseHook / runPostToolUseHook in wire-helpers.ts).
    // The field is `id`, not `toolCallId` — `toolCallId` is on ToolCallRecord
    // which never reaches the hook pipeline.
    const toolCall = p.toolCall as Record<string, unknown> | undefined;
    return typeof toolCall?.id === "string" ? toolCall.id : undefined;
  }
  if (event === "PreStateCommit" || event === "PostStateCommit") {
    const proposal = p.proposal as Record<string, unknown> | undefined;
    return typeof proposal?.id === "string" ? proposal.id : undefined;
  }
  return undefined;
}

/**
 * Map a HookEvent to the domain category of its primary target so trace
 * consumers don't have to re-derive the classification.
 */
function extractTargetType(event: HookEvent): "proposal" | "toolCall" | "turn" {
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
      return "toolCall";
    case "PreStateCommit":
    case "PostStateCommit":
      return "proposal";
    case "TurnStart":
    case "TurnStop":
    case "PreRuntime":
    case "PostRuntime":
    default:
      return "turn";
  }
}

/**
 * Extract the `proposal.type` from a state-commit hook payload so the
 * `hook.aborted` trace row keeps the `proposalType` field the pre-refactor
 * inline trace write carried. Returns `undefined` for other hook events or
 * when the payload shape is unexpected.
 */
function extractProposalType(
  event: HookEvent,
  payload: unknown,
): string | undefined {
  if (event !== "PreStateCommit" && event !== "PostStateCommit")
    return undefined;
  if (!payload || typeof payload !== "object") return undefined;
  const proposal = (payload as { proposal?: unknown }).proposal;
  if (!proposal || typeof proposal !== "object") return undefined;
  const type = (proposal as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
