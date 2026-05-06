/**
 * `<AssetGenericLink>` — fallback renderer for any modality without a
 * dedicated component (e.g. `'tile'`, `'avatar'`, `'dialogue-asset'`,
 * future `'3d-model'` / `'lipsync-track'` per SPEC §5.7).
 *
 * Surfaces:
 *   - the modality + source runtime as a header strip
 *   - a download link (resolves through `<Media>` so the IDB cache and signed
 *     URL endpoint are reused — even a `file` MIME goes through the same
 *     resolver)
 *   - a collapsed `<details>` block of the asset's `meta` JSON so the player
 *     can inspect what the plugin attached without us having to know the
 *     modality-specific shape
 *
 * The component is deliberately conservative: it never tries to embed unknown
 * mime types as media because that is what blew up the legacy `<Image>`
 * renderer when plugins started shipping `audio/*` payloads through it.
 */

import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { Media } from "@/components/Media.js";

export interface AssetGenericLinkProps {
	readonly view: AssetGenerateView;
	readonly sessionId: string;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function AssetGenericLink({
	view,
	sessionId,
}: AssetGenericLinkProps): ReactElement {
	const subtitle = view.source.runtimeId;
	const hasMeta = view.meta && Object.keys(view.meta).length > 0;

	return (
		<section
			className="ui-asset-generic flex flex-col gap-2 w-full border border-border rounded-[var(--radius-card)] p-3 bg-card"
			aria-label={`asset ${view.modality}`}
		>
			<header className="ui-eyebrow text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80 flex flex-wrap items-baseline gap-x-2">
				<span className="text-foreground/80">{view.modality}</span>
				{subtitle ? <span className="opacity-60">· {subtitle}</span> : null}
				<span className="opacity-50">· {view.ref.mime}</span>
			</header>
			{/*
        Use Media's `file` fallback path — passing as="auto" lets it sniff
        mime and route to <img>/<audio>/<video> when the modality happens to
        carry recognised media; truly unknown payloads collapse to a
        styled download <a>.
      */}
			<Media
				src={view.ref}
				sessionId={sessionId}
				alt={view.modality}
				as="auto"
			/>
			{hasMeta ? (
				<details className="text-[11px] font-mono text-muted-foreground/80">
					<summary className="cursor-pointer select-none opacity-70 hover:opacity-100">
						meta
					</summary>
					<pre className="mt-1 p-2 bg-muted/40 rounded text-[10px] whitespace-pre-wrap break-all">
						{safeStringify(view.meta)}
					</pre>
				</details>
			) : null}
		</section>
	);
}
