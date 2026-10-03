import { useStateStore } from "@json-render/react";
import {
  resolveActionParams,
  matchesPendingDraft,
} from "../interaction-selection.js";
import { useSession } from "@/stores/session-store.js";

const invocationParams = new Map<string, readonly [string, string]>([
  ["invokeRuntime", ["runtime", "runtimeId"]],
  ["invokePluginAction", ["action", "action"]],
  ["invokeCommand", ["command", "command"]],
]);

interface ActionBinding {
  readonly action: string;
  readonly params?: unknown;
}

/**
 * Feedback for a clickable catalog element, derived from its click binding.
 *
 * `isSelected`: the action stashed a pending draft (draftMessage /
 * selectChoice / …) that is still queued, so the element echoes the pick.
 * `isPending`: PluginPanel writes `/_invoking/<key>` while an
 * `invokeRuntime`, `invokePluginAction` or `invokeCommand` call is in flight;
 * the binding tells us which key it would set, so only the element that fired
 * the action shows as busy.
 *
 * The match is framework-neutral: it inspects the binding's params and the
 * active drafts, never a plugin id.
 */
export function useActionFeedback(
  click: ActionBinding | readonly ActionBinding[] | undefined,
): { readonly isSelected: boolean; readonly isPending: boolean } {
  const { state } = useSession();
  const pendingDrafts = state.pendingInteractionDrafts;
  const { get: getState } = useStateStore();
  const invokingMap =
    (getState("/_invoking") as Record<string, boolean> | undefined) ?? {};
  const bindings = click ? (Array.isArray(click) ? click : [click]) : [];
  let isSelected = false;
  let isPending = false;
  // `getState` is stable even when the store changes. Resolve dynamic action
  // params on each render so both feedback states track the current snapshot.
  for (const binding of bindings as readonly ActionBinding[]) {
    const resolved = resolveActionParams(
      binding.params as Record<string, unknown> | undefined,
      getState,
    );
    isSelected ||= matchesPendingDraft(resolved, pendingDrafts);
    const invocation = invocationParams.get(binding.action);
    if (invocation) {
      const [kind, param] = invocation;
      const id = resolved[param];
      isPending ||= typeof id === "string" && !!invokingMap[`${kind}:${id}`];
    }
  }
  return { isSelected, isPending };
}
