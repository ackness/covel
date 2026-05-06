/**
 * Lightweight pub/sub bridge so the global topbar nav can poke into
 * page-local state (open settings, switch right-panel tab, etc.) without
 * threading callbacks through the router or hoisting state into a context.
 *
 * Each session-shell component subscribes to the events it cares about and
 * the topbar dispatches by name.
 */

export type NavEvent = "open-plugins" | "open-images" | "open-database";

type Listener = (event: NavEvent) => void;

const listeners = new Set<Listener>();

export function emitNavEvent(event: NavEvent): void {
	for (const listener of listeners) listener(event);
}

export function onNavEvent(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
