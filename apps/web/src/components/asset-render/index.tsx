/**
 * `<AssetRender>` — modality-aware router for `AssetGenerateView` payloads
 * arriving over the `asset.generated` SSE channel (P0-b, SPEC §5.7).
 *
 * Routing table:
 *   `image` → AssetImage
 *   `audio` → AssetAudio
 *   *anything else (`tile` / `avatar` / `dialogue-asset` / `video` / future
 *    modalities)* → AssetGenericLink
 *
 * The framework intentionally does not enumerate every modality here —
 * SPEC §5.7 keeps the modality string open so plugin authors can ship new
 * shapes without a framework PR. P0 ships sensible defaults for the two
 * modalities the kernel currently emits and a generic-link fallback for
 * everything else.
 *
 * Data flow:
 *   kernel.commitProposal(asset.generate)
 *     → emit('asset.generated', { asset: AssetGenerateView })
 *     → web SSE handler
 *     → session-store reducer state.assetsByTurn
 *     → <AssetTurnSidebar turnId={...}>
 *     → <AssetRender view={...}>
 *     → <AssetImage|AssetAudio|AssetGenericLink>
 */

import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { AssetImage } from "./AssetImage.js";
import { AssetAudio } from "./AssetAudio.js";
import { AssetGenericLink } from "./AssetGenericLink.js";

export interface AssetRenderProps {
	readonly view: AssetGenerateView;
	readonly sessionId: string;
}

export function AssetRender({
	view,
	sessionId,
}: AssetRenderProps): ReactElement {
	switch (view.modality) {
		case "image":
			return <AssetImage view={view} sessionId={sessionId} />;
		case "audio":
			return <AssetAudio view={view} sessionId={sessionId} />;
		default:
			return <AssetGenericLink view={view} sessionId={sessionId} />;
	}
}

export { AssetImage } from "./AssetImage.js";
export { AssetAudio } from "./AssetAudio.js";
export { AssetGenericLink } from "./AssetGenericLink.js";
export { AssetTurnSidebar } from "./AssetTurnSidebar.js";
