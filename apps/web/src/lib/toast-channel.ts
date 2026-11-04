/**
 * Toast shorthand over the notice center. `emitToast` keeps the signature of
 * the original channel: about a hundred call sites publish one-shot results
 * through it.
 */

import {
  pushNotice,
  subscribeToastShown,
  type NoticeRecord,
} from "./notice-center.js";

export type ToastKind = "error" | "info" | "success";

export interface ToastEvent {
  /** Monotonic id used as the React key. */
  id: number;
  kind: ToastKind;
  /** Short headline shown in the toast body. */
  message: string;
  /** Optional secondary text (e.g. raw server response) — surfaced via "copy detail". */
  detail?: string;
  /** Epoch ms — used for ordering / logging. */
  timestamp: number;
  /** How long the toast stays; the default depends on the kind. */
  durationMs?: number;
}

export function emitToast(
  kind: ToastKind,
  message: string,
  detail?: string,
  options: { durationMs?: number } = {},
): void {
  pushNotice({
    key: `toast:${kind}:${message}`,
    kind: "toast",
    tone: kind,
    title: message,
    ...(detail === undefined ? {} : { detail }),
    ...(options.durationMs ? { durationMs: options.durationMs } : {}),
  });
}

function toEvent(notice: NoticeRecord): ToastEvent {
  return {
    id: notice.id,
    kind: notice.tone === "warning" ? "info" : notice.tone,
    message: notice.title,
    ...(notice.detail === undefined ? {} : { detail: notice.detail }),
    timestamp: notice.updatedAt,
    ...(notice.durationMs ? { durationMs: notice.durationMs } : {}),
  };
}

/** Listen to every toast as it is shown. Returns an unsubscribe function. */
export function subscribeToast(cb: (event: ToastEvent) => void): () => void {
  return subscribeToastShown((notice) => cb(toEvent(notice)));
}
