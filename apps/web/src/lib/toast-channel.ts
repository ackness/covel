/**
 * Global toast channel — dependency-free pub/sub for surfacing server-side
 * and client-side errors as in-app notifications.
 *
 * Keep the API minimal: `emit()` publishes an event, `subscribe()` registers
 * a listener and returns an unsubscribe function. ToastHost is the only
 * intended consumer today, but anything else in the web app may subscribe.
 */

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
}

type Subscriber = (event: ToastEvent) => void;

const subscribers: Subscriber[] = [];
let nextId = 1;

export function emitToast(
	kind: ToastKind,
	message: string,
	detail?: string,
): void {
	// Clamp absurdly long details so copy-to-clipboard payloads stay sane.
	const trimmedDetail =
		typeof detail === "string" && detail.length > 4000
			? `${detail.slice(0, 4000)}…`
			: detail;

	const event: ToastEvent = {
		id: nextId++,
		kind,
		message,
		detail: trimmedDetail,
		timestamp: Date.now(),
	};

	// Iterate a snapshot so a subscriber that unsubscribes mid-dispatch
	// doesn't skip siblings.
	for (const cb of [...subscribers]) {
		try {
			cb(event);
		} catch (err) {
			// Subscriber threw — isolate the failure, do not break the channel.
			// eslint-disable-next-line no-console
			console.warn("[toast-channel] subscriber threw:", err);
		}
	}
}

export function subscribeToast(cb: Subscriber): () => void {
	subscribers.push(cb);
	return () => {
		const idx = subscribers.indexOf(cb);
		if (idx >= 0) subscribers.splice(idx, 1);
	};
}

/** Test helper — exposed for unit tests, no callers expected in prod code. */
export function __resetToastChannelForTests(): void {
	subscribers.length = 0;
	nextId = 1;
}
