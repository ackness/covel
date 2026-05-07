/**
 * Interaction selection — framework-neutral visual-selection tracking for
 * plugin-declared interactive elements rendered via json-render.
 *
 * PendingInteractionDraft is defined locally rather than imported so this
 * module stays decoupled from the session store.
 */

/** Shape of a pending interaction draft for selection matching. */
export interface PendingInteractionDraft {
  selectionGroup?: string;
  label?: string;
  values?: Record<string, unknown>;
}

/**
 * Resolve a single param value that might be a `{$state: "..."}` reference
 * produced by json-render's flat spec format.
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
    return Object.fromEntries(
      Object.entries(ref).map(([key, nested]) => [
        key,
        resolveDynamicParam(nested, getState),
      ]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDynamicParam(item, getState));
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
 */
export function matchesPendingDraft(
  params: Record<string, unknown>,
  drafts: readonly PendingInteractionDraft[],
): boolean {
  const group = params.selectionGroup;
  const text = params.text ?? params.label;
  const choiceId = params.choiceId ?? params.candidateId;

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
      const selectedId = values.selectedId ?? values.candidateId;
      if (selectedId !== undefined && String(selectedId) === String(choiceId)) {
        return true;
      }
    }

    // Heuristic 3: plain draft text match. Candidate reply blocks can use
    // draft/send/accept action names with only a text payload, while older
    // guide specs use selection groups. This keeps both shapes visually
    // selectable through shared draft metadata.
    if (text !== undefined && draft.values) {
      const values = draft.values as Record<string, unknown>;
      const draftText = values.text ?? draft.label;
      if (draftText !== undefined && String(draftText) === String(text)) {
        return true;
      }
    }
  }

  return false;
}
