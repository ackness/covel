/**
 * `<AssetTurnSidebar turnId={...}>` — fans out every `AssetGenerateView`
 * recorded for a turn into stacked `<AssetRender>` cards.
 *
 * Reads from `state.assetsByTurn.get(turnId)` populated by the
 * `asset.generated` SSE handler (P0-b). When a turn has no assets the
 * component renders nothing — callers can safely mount it under every
 * assistant message without paying a layout cost on text-only turns.
 *
 * SPEC §5.7 unlocks: this is the "independent gallery / sidecar" hook.
 * Plugin specs can opt-in via the catalog entry `AssetTurnSidebar` instead
 * of having the framework hard-mount it inside the timeline — that keeps
 * the message column under plugin authors' control.
 *
 * The component soft-binds to `useSession`: when rendered outside a
 * `SessionProvider` (debug fixtures, snapshot tests) it returns `null`
 * rather than throwing. Same pattern as `useActiveSessionId` in catalog.tsx.
 */

import type { ReactElement } from "react";
import { useSession } from "@/stores/session-store.js";
import { AssetRender } from "./index.js";

export interface AssetTurnSidebarProps {
	readonly turnId: string;
	/** Override the session id (e.g. when rendering historical turns from another session). */
	readonly sessionId?: string;
}

export function AssetTurnSidebar({
	turnId,
	sessionId: sessionIdOverride,
}: AssetTurnSidebarProps): ReactElement | null {
	// Soft-bind: when no SessionProvider is mounted (debug pages, isolated
	// tests) we return null. Throwing here would crash the catalog renderer.
	let assets: readonly import("@covel/shared").AssetGenerateView[] | undefined;
	let sessionId: string | undefined;
	try {
		const { state } = useSession();
		assets = state.assetsByTurn.get(turnId);
		sessionId = sessionIdOverride ?? state.session?.id ?? "";
	} catch {
		return null;
	}

	if (!assets || assets.length === 0) return null;

	return (
		<div
			className="ui-asset-turn-sidebar flex flex-col gap-3 w-full"
			data-turn-id={turnId}
		>
			{assets.map((view) => (
				<AssetRender key={view.id} view={view} sessionId={sessionId ?? ""} />
			))}
		</div>
	);
}
