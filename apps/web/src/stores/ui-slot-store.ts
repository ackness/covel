import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  uiSlotSnapshotSchema,
  type UiSlotName,
  type UiSlotSnapshot,
} from "@covel/shared";
import { request } from "@/services/api/request.js";

type VisibleSlot = UiSlotSnapshot & { readonly previewTurnId?: string };
interface SlotState {
  committed: Map<string, UiSlotSnapshot>;
  previews: Map<string, VisibleSlot>;
  endedTurns: Set<string>;
  revisions: Map<string, number>;
  sequence: number;
  visible: readonly VisibleSlot[];
  loading?: Promise<void>;
}
const states = new Map<string, SlotState>();
const listeners = new Set<() => void>();
const EMPTY: readonly VisibleSlot[] = [];
const identity = (slot: string, key?: string) =>
  JSON.stringify([slot, key ?? null]);
const stateFor = (sessionId: string) => {
  let state = states.get(sessionId);
  if (!state) {
    state = {
      committed: new Map(),
      previews: new Map(),
      endedTurns: new Set(),
      revisions: new Map(),
      sequence: 0,
      visible: EMPTY,
    };
    states.set(sessionId, state);
  }
  return state;
};
const publish = (state: SlotState) => {
  state.visible = [
    ...new Map([...state.committed, ...state.previews]).values(),
  ];
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function refreshUiSlots(sessionId: string): Promise<void> {
  const state = stateFor(sessionId);
  if (state.loading) return state.loading;
  const started = state.sequence;
  state.loading = request<{ items: UiSlotSnapshot[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/ui-slots`,
    { sessionId },
  )
    .then((response) => {
      if (states.get(sessionId) !== state) return;
      const received = new Set<string>();
      for (const candidate of response.items) {
        const parsed = uiSlotSnapshotSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const key = identity(parsed.data.slot, parsed.data.key);
        received.add(key);
        if ((state.revisions.get(key) ?? 0) > started) continue;
        state.committed.set(key, parsed.data);
      }
      for (const key of state.committed.keys()) {
        if (!received.has(key) && (state.revisions.get(key) ?? 0) <= started)
          state.committed.delete(key);
      }
      publish(state);
    })
    .finally(() => {
      state.loading = undefined;
    });
  return state.loading;
}

/** Shared by action SSE and the durable background subscription. */
export function applyUiSlotEvent(
  sessionId: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  turnId?: string,
): boolean {
  const state = stateFor(sessionId);
  const turn = typeof payload.turnId === "string" ? payload.turnId : turnId;
  if (type === "runtime.started" || type === "execution.started") {
    if (turn) state.endedTurns.delete(turn);
    return false;
  }
  if (type === "system.reset") {
    state.previews.clear();
    publish(state);
    void refreshUiSlots(sessionId).catch(() => {});
    return false;
  }
  if (
    type === "ui.slot.cleared" ||
    type === "execution.completed" ||
    type === "turn.completed" ||
    type === "error.occurred" ||
    type === "turn.failed" ||
    type === "execution.aborted" ||
    type === "execution.commit_failed"
  ) {
    if (turn) {
      state.endedTurns.add(turn);
      if (state.endedTurns.size > 128)
        state.endedTurns.delete(state.endedTurns.values().next().value!);
      for (const [key, preview] of state.previews)
        if (preview.previewTurnId === turn) state.previews.delete(key);
      publish(state);
    }
    return type === "ui.slot.cleared";
  }
  if (type !== "ui.slot.changed" && type !== "ui.slot.preview") return false;
  const parsed = uiSlotSnapshotSchema.safeParse({
    slot: payload.slot,
    ...(typeof payload.key === "string" ? { key: payload.key } : {}),
    value: payload.value,
    revision: payload.revision,
  });
  if (!parsed.success) return true;
  const key = identity(parsed.data.slot, parsed.data.key);
  if (type === "ui.slot.preview") {
    if (!turn || state.endedTurns.has(turn)) return true;
    state.previews.set(key, { ...parsed.data, previewTurnId: turn });
  } else {
    state.revisions.set(key, ++state.sequence);
    state.committed.set(key, parsed.data);
  }
  publish(state);
  return true;
}

export function clearUiSlots(sessionId?: string): void {
  if (sessionId) states.delete(sessionId);
  else states.clear();
  for (const listener of listeners) listener();
}
export function useUiSlots(
  sessionId: string,
  prefix?: string,
): readonly VisibleSlot[] {
  useEffect(() => {
    if (sessionId) void refreshUiSlots(sessionId).catch(() => {});
  }, [sessionId]);
  const values = useSyncExternalStore(
    subscribe,
    () => states.get(sessionId)?.visible ?? EMPTY,
  );
  return useMemo(
    () =>
      prefix ? values.filter((entry) => entry.slot.startsWith(prefix)) : values,
    [values, prefix],
  );
}
export function useUiSlot(
  sessionId: string,
  slot: UiSlotName,
  key?: string,
): VisibleSlot | undefined {
  return useUiSlots(sessionId, slot).find(
    (entry) => entry.slot === slot && entry.key === key,
  );
}
