/**
 * Interaction selection — framework-neutral visual-selection tracking for
 * plugin-declared interactive elements rendered via json-render.
 *
 * When the user clicks a plugin-supplied button (via `draftMessage`,
 * `selectChoice`, `selectSuggestion`, etc.) we stash a pending interaction
 * draft in the session store. The framework needs to echo this choice back
 * to the user visually — the clicked button should look "selected" until
 * the draft is sent or dismissed.
 *
 * This module provides the matching heuristic: given an ActionBinding's
 * params and the current pending drafts, decide whether the button should
 * be highlighted. The logic is purely structural — no plugin IDs, no
 * hardcoded action names beyond the shapes the framework itself emits.
 */

import type { PendingInteractionDraft } from "@/stores/session-store.js";

/**
 * Resolve a single param value that might be a `{$state: "..."}` reference
 * produced by json-render's flat spec format. Literal values pass through
 * unchanged. Unknown reference shapes return the raw value so the caller's
 * comparison can still fail gracefully instead of throwing.
 */
export function resolveDynamicParam(
  value: unknown,
  getState: (path: string) => unknown,
): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    if (typeof ref.$state === "string") {
      return getState(ref.$state);
    }
    if (typeof ref.$bindState === "string") {
      return getState(ref.$bindState);
    }
  }
  return value;
}

/**
 * Resolve all params on an ActionBinding, materialising `$state` references
 * into their current values.
 */
export function resolveActionParams(
  rawParams: Record<string, unknown> | undefined,
  getState: (path: string) => unknown,
): Record<string, unknown> {
  if (!rawParams) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    resolved[key] = resolveDynamicParam(value, getState);
  }
  return resolved;
}

/**
 * Given resolved click params and the list of pending drafts, determine
 * whether any draft represents a selection that matches this click.
 *
 * Matching heuristics (in order):
 *
 * 1. `selectionGroup` + text/label match — used by `draftMessage` and any
 *    grouped suggestion UX. A draft is considered the "selected option" in
 *    its group when `draft.selectionGroup === params.selectionGroup` and
 *    the button's resolved `text`/`label` matches the draft's `label`.
 *
 * 2. `choiceId` match — used by `selectChoice` and other single-choice form
 *    elements. A draft matches when `draft.values.selectedId === params.choiceId`.
 *
 * Both heuristics are plugin-neutral: the framework inspects only the
 * param field names, never plugin IDs or interaction IDs. Plugins opt in
 * by naming their click params consistently (the existing conventions).
 */
export function matchesPendingDraft(
  params: Record<string, unknown>,
  drafts: readonly PendingInteractionDraft[],
): boolean {
  const group = params.selectionGroup;
  const text = params.text ?? params.label;
  const choiceId = params.choiceId;

  for (const draft of drafts) {
    // Heuristic 1: selectionGroup + label/text match
    if (
      typeof group === "string" &&
      draft.selectionGroup === group &&
      text !== undefined &&
      draft.label === String(text)
    ) {
      return true;
    }

    // Heuristic 2: choiceId match against values.selectedId
    if (choiceId !== undefined && draft.values) {
      const values = draft.values as Record<string, unknown>;
      if (
        values.selectedId !== undefined &&
        String(values.selectedId) === String(choiceId)
      ) {
        return true;
      }
    }
  }

  return false;
}
