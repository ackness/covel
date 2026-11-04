/**
 * Notice center: the one channel for everything the app tells the player
 * outside the story.
 *
 * - `toast`: one-shot result. Fades out; the host owns the timer.
 * - `card`: derived from state. Present while a condition holds; the player
 *   can collapse it into the bell, where it stays open until resolved.
 * - `status`: derived from state. A small chip in the session header.
 *
 * Dependency-free apart from the type-only `ReactNode`, so any module can
 * publish, and React reads it through `useSyncExternalStore`.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export type NoticeKind = "toast" | "card" | "status";
export type NoticeTone = "info" | "success" | "warning" | "error";

export interface NoticeAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: "default" | "outline" | "ghost";
  readonly disabled?: boolean;
}

export interface NoticeInput {
  /** Dedupe/replace key: pushing the same key replaces the entry. */
  readonly key: string;
  readonly kind: NoticeKind;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body?: string;
  /** Copyable secondary text, such as a raw server response. */
  readonly detail?: string;
  /** At most two are kept. */
  readonly actions?: readonly NoticeAction[];
  /** A rich body for a card, shown under the title. */
  readonly render?: () => ReactNode;
  /** `"global"` or a session id. */
  readonly scope?: string;
  /**
   * Cards only: runs instead of collapsing when the player closes the card.
   * A card that is closed for good removes itself here.
   */
  readonly onDismiss?: () => void;
  /** Toasts only: how long it stays. */
  readonly durationMs?: number;
  /** History only; shown as a toast only while developer mode is on. */
  readonly quiet?: boolean;
}

export interface NoticeRecord extends Omit<NoticeInput, "scope"> {
  readonly id: number;
  readonly scope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CardState {
  readonly notice: NoticeRecord;
  readonly collapsed: boolean;
  /** Re-registered with different content while collapsed. */
  readonly changed: boolean;
}

export type NoticeHistoryState = "open" | "resolved" | "shown" | "quiet";

export interface NoticeHistoryItem {
  readonly id: number;
  readonly key: string;
  readonly kind: NoticeKind;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body?: string;
  readonly detail?: string;
  readonly scope: string;
  readonly at: number;
  readonly state: NoticeHistoryState;
}

export interface NoticeSnapshot {
  readonly toasts: readonly NoticeRecord[];
  readonly cards: readonly CardState[];
  readonly statuses: readonly NoticeRecord[];
  readonly history: readonly NoticeHistoryItem[];
}

export const MAX_VISIBLE_TOASTS = 3;
export const HISTORY_LIMIT = 50;
export const DETAIL_LIMIT = 4000;
export const MAX_ACTIONS = 2;
const TOAST_MS: Record<NoticeTone, number> = {
  info: 3000,
  success: 3000,
  warning: 3000,
  error: 6000,
};

export function toastDuration(notice: NoticeRecord): number {
  return notice.durationMs ?? TOAST_MS[notice.tone];
}

let nextId = 1;
let snapshot: NoticeSnapshot = {
  toasts: [],
  cards: [],
  statuses: [],
  history: [],
};
const listeners = new Set<() => void>();
const toastListeners = new Set<(notice: NoticeRecord) => void>();
// Value signatures of registered card/status entries.
const signatures = new Map<string, string>();

function publish(next: Partial<NoticeSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of [...listeners]) listener();
}

function clampDetail(detail: string | undefined): string | undefined {
  return typeof detail === "string" && detail.length > DETAIL_LIMIT
    ? `${detail.slice(0, DETAIL_LIMIT)}…`
    : detail;
}

let readDeveloperMode: () => boolean = () => false;

/**
 * The settings store registers how to read `ui.developerView`, so the notice
 * center stays free of the settings module (and the modules it pulls in).
 */
export function setDeveloperModeReader(read: () => boolean): void {
  readDeveloperMode = read;
}

function developerMode(): boolean {
  try {
    return readDeveloperMode();
  } catch {
    return false;
  }
}

function toRecord(input: NoticeInput, previous?: NoticeRecord): NoticeRecord {
  const now = Date.now();
  const { scope, detail, actions, ...rest } = input;
  return {
    ...rest,
    ...(detail === undefined ? {} : { detail: clampDetail(detail) }),
    ...(actions?.length ? { actions: actions.slice(0, MAX_ACTIONS) } : {}),
    id: nextId++,
    scope: scope ?? "global",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** What makes two registrations "the same": data, not function identity. */
function signature(input: NoticeInput): string {
  return JSON.stringify([
    input.kind,
    input.tone,
    input.title,
    input.body ?? null,
    input.detail ?? null,
    input.scope ?? "global",
    (input.actions ?? [])
      .slice(0, MAX_ACTIONS)
      .map((a) => [a.label, a.variant, a.disabled === true]),
    Boolean(input.render),
    Boolean(input.onDismiss),
  ]);
}

function addHistory(
  history: readonly NoticeHistoryItem[],
  item: NoticeHistoryItem,
): NoticeHistoryItem[] {
  const next = [...history.filter((entry) => !sameItem(entry, item)), item];
  // Keep the newest HISTORY_LIMIT entries of this scope.
  let inScope = 0;
  const kept: NoticeHistoryItem[] = [];
  for (let i = next.length - 1; i >= 0; i--) {
    const entry = next[i]!;
    if (entry.scope === item.scope) {
      if (inScope >= HISTORY_LIMIT) continue;
      inScope++;
    }
    kept.push(entry);
  }
  return kept.reverse();
}

/** A card has one history row per key; everything else adds rows. */
function sameItem(a: NoticeHistoryItem, b: NoticeHistoryItem): boolean {
  return (
    b.kind === "card" &&
    a.kind === "card" &&
    a.key === b.key &&
    a.scope === b.scope &&
    a.state === "open"
  );
}

function historyItem(
  notice: NoticeRecord,
  state: NoticeHistoryState,
): NoticeHistoryItem {
  return {
    id: notice.id,
    key: notice.key,
    kind: notice.kind,
    tone: notice.tone,
    title: notice.title,
    ...(notice.body === undefined ? {} : { body: notice.body }),
    ...(notice.detail === undefined ? {} : { detail: notice.detail }),
    scope: notice.scope,
    at: notice.updatedAt,
    state,
  };
}

function pushToast(input: NoticeInput): void {
  const record = toRecord(input);
  const quiet = input.quiet === true;
  const show = !quiet || developerMode();
  let toasts = snapshot.toasts;
  if (show) {
    toasts = [...toasts.filter((toast) => toast.key !== record.key), record];
    if (toasts.length > MAX_VISIBLE_TOASTS)
      toasts = toasts.slice(toasts.length - MAX_VISIBLE_TOASTS);
  }
  publish({
    toasts,
    history: addHistory(
      snapshot.history,
      historyItem(record, quiet ? "quiet" : "shown"),
    ),
  });
  if (show) {
    for (const listener of [...toastListeners]) {
      try {
        listener(record);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[notice-center] toast listener threw:", error);
      }
    }
  }
}

/** Publish a toast or quiet entry. Cards and chips use `useNotice`. */
export function pushNotice(input: NoticeInput): void {
  if (input.kind !== "toast") {
    registerNotice(input);
    return;
  }
  pushToast(input);
}

/** Register (or replace) a state-derived card or status chip. */
export function registerNotice(input: NoticeInput): void {
  if (input.kind === "toast") {
    pushToast(input);
    return;
  }
  const sig = signature(input);
  if (signatures.get(input.key) === sig) return;
  signatures.set(input.key, sig);
  const record = toRecord(input);
  if (input.kind === "status") {
    publish({
      statuses: [
        ...snapshot.statuses.filter((s) => s.key !== input.key),
        record,
      ],
    });
    return;
  }
  const existing = snapshot.cards.find((card) => card.notice.key === input.key);
  const card: CardState = existing
    ? {
        notice: { ...record, createdAt: existing.notice.createdAt },
        collapsed: existing.collapsed,
        changed: existing.collapsed,
      }
    : { notice: record, collapsed: false, changed: false };
  publish({
    cards: existing
      ? snapshot.cards.map((entry) => (entry === existing ? card : entry))
      : [...snapshot.cards, card],
    history: addHistory(snapshot.history, historyItem(card.notice, "open")),
  });
}

/** Remove a card or status chip because its condition ended. */
export function removeNotice(key: string): void {
  signatures.delete(key);
  const card = snapshot.cards.find((entry) => entry.notice.key === key);
  const status = snapshot.statuses.find((entry) => entry.key === key);
  if (card) {
    publish({
      cards: snapshot.cards.filter((entry) => entry !== card),
      history: snapshot.history.map((item) =>
        item.kind === "card" &&
        item.key === key &&
        item.scope === card.notice.scope &&
        item.state === "open"
          ? { ...item, state: "resolved" as const }
          : item,
      ),
    });
  } else if (status) {
    publish({
      statuses: snapshot.statuses.filter((entry) => entry !== status),
    });
  }
}

/** Collapse a card into the bell, or drop a toast from the screen. */
export function dismissNotice(key: string): void {
  const card = snapshot.cards.find((entry) => entry.notice.key === key);
  if (card) {
    if (card.collapsed && !card.changed) return;
    publish({
      cards: snapshot.cards.map((entry) =>
        entry === card ? { ...entry, collapsed: true, changed: false } : entry,
      ),
    });
    return;
  }
  const toasts = snapshot.toasts.filter((toast) => toast.key !== key);
  if (toasts.length !== snapshot.toasts.length) publish({ toasts });
}

/** Drop one visible toast by id (timeout or the close button). */
export function dismissToast(id: number): void {
  const toasts = snapshot.toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== snapshot.toasts.length) publish({ toasts });
}

/** Show a collapsed card again. */
export function restoreNotice(key: string): void {
  const card = snapshot.cards.find((entry) => entry.notice.key === key);
  if (!card || (!card.collapsed && !card.changed)) return;
  publish({
    cards: snapshot.cards.map((entry) =>
      entry === card ? { ...entry, collapsed: false, changed: false } : entry,
    ),
  });
}

/**
 * Re-render hosts without changing any entry. A card whose `render` closes
 * over the producer's state calls this after the producer renders.
 */
export function refreshNotices(): void {
  publish({});
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNoticeSnapshot(): NoticeSnapshot {
  return snapshot;
}

/** Fires for every toast that is shown (not for history-only entries). */
export function subscribeToastShown(
  listener: (notice: NoticeRecord) => void,
): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

/** Read the store from React. `selector` may be an inline function. */
export function useNotices<T>(selector: (state: NoticeSnapshot) => T): T {
  const state = useSyncExternalStore(
    subscribeNotices,
    getNoticeSnapshot,
    getNoticeSnapshot,
  );
  const latest = useRef(selector);
  latest.current = selector;
  return useMemo(() => latest.current(state), [state]);
}

/**
 * Register a card or status chip while the component is mounted and the entry
 * is non-null. Comparison is by value, so re-rendering with the same data
 * does not churn; action handlers and `render` always call the latest ones.
 */
export function useNotice(input: NoticeInput | null): void {
  const latest = useRef(input);
  latest.current = input;
  const sig = input ? signature(input) : null;
  const key = input?.key ?? null;
  useEffect(() => {
    const current = latest.current;
    if (!current || key === null) return;
    registerNotice({
      ...current,
      ...(current.actions
        ? {
            actions: current.actions.map((action, index) => ({
              ...action,
              onClick: () => latest.current?.actions?.[index]?.onClick(),
            })),
          }
        : {}),
      ...(current.onDismiss
        ? { onDismiss: () => latest.current?.onDismiss?.() }
        : {}),
      ...(current.render
        ? { render: () => latest.current?.render?.() ?? null }
        : {}),
    });
  }, [key, sig]);
  // Removal follows the key, not the content: a card whose text changes stays
  // where the player put it (collapsed or not).
  useEffect(() => (key === null ? undefined : () => removeNotice(key)), [key]);
  const rich = Boolean(input?.render);
  useEffect(() => {
    if (rich) refreshNotices();
  });
}

/** Test helper: forget everything. */
export function resetNoticeCenter(): void {
  signatures.clear();
  snapshot = { toasts: [], cards: [], statuses: [], history: [] };
  for (const listener of [...listeners]) listener();
}
