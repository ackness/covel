/**
 * `<AssetImage>` — default renderer for `asset.generate{ modality: 'image' }`.
 *
 * Wraps `<Media>` with a thin caption strip so the player can see what runtime
 * produced the image and (when present) the prompt that drove it. Title +
 * subtitle live above the image so the layout stays predictable for stacked
 * gallery rendering. All blob/cache plumbing lives inside `<Media>` — this
 * component is intentionally a presentation shell.
 *
 * SPEC §5.7 — modality routing default for `'image'`.
 */

import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { Media } from "@/components/Media.js";

export interface AssetImageProps {
	readonly view: AssetGenerateView;
	readonly sessionId: string;
}

function readPrompt(meta: AssetGenerateView["meta"]): string | null {
	if (!meta) return null;
	const prompt = (meta as Record<string, unknown>).prompt;
	return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
}

export function AssetImage({ view, sessionId }: AssetImageProps): ReactElement {
	const prompt = readPrompt(view.meta);
	const title = prompt ?? view.modality;
	const subtitle = view.source.runtimeId;

	return (
		<figure className="ui-asset-image flex flex-col gap-1.5 w-full">
			<figcaption className="ui-eyebrow text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80 flex flex-wrap items-baseline gap-x-2">
				<span className="text-foreground/80">{title}</span>
				{subtitle ? <span className="opacity-60">· {subtitle}</span> : null}
			</figcaption>
			<Media
				src={view.ref}
				sessionId={sessionId}
				alt={prompt ?? `${view.modality} asset`}
				as="image"
				rounded="md"
			/>
		</figure>
	);
}
