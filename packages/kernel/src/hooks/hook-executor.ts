import type { ScopedHookRegistry } from "@covel/plugin-runtime";
import type { HookEvent } from "@covel/shared";

export interface HookContext {
  event: HookEvent;
  turnId: string;
  runId: string;
  branchId: string;
  locale: string;
  /** Proposals data (for PreStateCommit/PostStateCommit). */
  proposals?: unknown[];
}

export interface HookExecutionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Execute all hooks registered for a lifecycle event.
 * Returns false if any hook blocked (denied) the action.
 *
 * Only hooks with `handlerKind === "command"` are executed (matching
 * the pattern used by PreToolUse/PostToolUse in tool-executor.ts).
 */
export async function executeHooks(
  hookRegistry: ScopedHookRegistry,
  context: HookContext
): Promise<HookExecutionResult> {
  const hooks = hookRegistry.getHooksForEvent(context.event);

  for (const hook of hooks) {
    if (hook.definition.handlerKind !== "command") continue;

    try {
      const result = await hook.handler({
        event: context.event,
        runtimeId: "",
        pluginId: hook.pluginId,
        locale: context.locale,
        proposals: context.proposals,
      });

      if (!result.allow) {
        return { allowed: false, reason: `Hook ${hook.pluginId} denied ${context.event}` };
      }
    } catch (err) {
      console.warn(
        `[hook-executor] Hook ${hook.pluginId} threw during ${context.event}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { allowed: true };
}
