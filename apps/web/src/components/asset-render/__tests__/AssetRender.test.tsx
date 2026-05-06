/**
 * Modality-routing tests for `<AssetRender>` (SPEC §5.7).
 *
 * The router is the only kernel-aware piece of the asset-render bundle —
 * everything else delegates to `<Media>` (already covered by Media.test.tsx)
 * or to plain layout. We verify here that:
 *
 *   - `modality: 'image'` mounts `<AssetImage>`
 *   - `modality: 'audio'` mounts `<AssetAudio>`
 *   - any other modality mounts `<AssetGenericLink>` (P0 fallback)
 *
 * `<Media>` is replaced with a stub so we can sniff routing without paying
 * for blob/IDB/URL plumbing — those paths have their own dedicated test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AssetGenerateView } from "@covel/shared";

// Stub `<Media>` and `<AudioPlayer>` before importing the asset-render
// bundle — `vi.mock` is hoisted to the top of the file by vitest, so the
// stubs are in place by the time `AssetRender` resolves its imports.
//
// AssetAudio routes through `<AudioPlayer>` (theme-aware self-drawn
// player); the other modalities still route through `<Media>`.  Both
// stubs expose the same `data-testid="media-stub"` shape so the routing
// assertions below stay focused on `data-as` / mime instead of which
// concrete component was picked.
vi.mock("@/components/Media.js", () => ({
	Media: ({
		src,
		sessionId,
		alt,
		as,
	}: {
		src: { id?: string; mime?: string };
		sessionId: string;
		alt?: string;
		as?: string;
	}) => (
		<div
			data-testid="media-stub"
			data-as={as}
			data-session-id={sessionId}
			data-alt={alt}
			data-mime={src?.mime ?? ""}
			data-id={src?.id ?? ""}
		/>
	),
}));
vi.mock("@/components/AudioPlayer.js", () => ({
	AudioPlayer: ({
		src,
		sessionId,
		alt,
	}: {
		src: { id?: string; mime?: string };
		sessionId: string;
		alt?: string;
	}) => (
		<div
			data-testid="media-stub"
			data-as="audio"
			data-session-id={sessionId}
			data-alt={alt}
			data-mime={src?.mime ?? ""}
			data-id={src?.id ?? ""}
		/>
	),
}));

import { AssetRender } from "../index.js";

afterEach(() => {
	cleanup();
});

function makeView(
	overrides: Partial<AssetGenerateView> = {},
): AssetGenerateView {
	return {
		id: "prop-1",
		type: "asset.generate",
		sessionId: "sess-1",
		turnId: "turn-1",
		source: { pluginId: "image", runtimeId: "image/runner" },
		ref: {
			id: "a".repeat(64),
			mime: "image/png",
			size: 16,
			url: "https://cdn.example/x.png",
		},
		modality: "image",
		createdAt: "2026-04-26T00:00:00.000Z",
		...overrides,
	};
}

describe("<AssetRender> modality routing", () => {
	it("routes `image` to AssetImage (figure with image-as Media)", () => {
		const view = makeView({ modality: "image" });
		render(<AssetRender view={view} sessionId="sess-1" />);

		// AssetImage mounts `<Media as="image">`; AssetGenericLink uses `as="auto"`
		// so the data-as attribute is enough to distinguish them.
		const stub = screen.getByTestId("media-stub");
		expect(stub.getAttribute("data-as")).toBe("image");
		// Subtitle should expose the runtime id so authors can trace the asset.
		expect(screen.getByText(/image\/runner/)).toBeTruthy();
	});

	it("routes `audio` to AssetAudio (figure with audio-as Media)", () => {
		const view = makeView({
			modality: "audio",
			ref: {
				id: "b".repeat(64),
				mime: "audio/wav",
				size: 32,
			},
		});
		render(<AssetRender view={view} sessionId="sess-1" />);

		const stub = screen.getByTestId("media-stub");
		expect(stub.getAttribute("data-as")).toBe("audio");
	});

	it("routes any other modality to AssetGenericLink", () => {
		const view = makeView({
			modality: "tile",
			ref: {
				id: "c".repeat(64),
				mime: "application/octet-stream",
				size: 64,
			},
			meta: { region: "north", layer: "fog" },
		});
		render(<AssetRender view={view} sessionId="sess-1" />);

		// Generic link mounts Media with as="auto" + a meta <details> block.
		const stub = screen.getByTestId("media-stub");
		expect(stub.getAttribute("data-as")).toBe("auto");
		expect(screen.getByText("meta")).toBeTruthy();
		expect(screen.getByText(/tile/)).toBeTruthy();
	});

	it("uses `meta.prompt` as the title when present (image)", () => {
		const view = makeView({ meta: { prompt: "a knight at dusk" } });
		render(<AssetRender view={view} sessionId="sess-1" />);
		expect(screen.getByText("a knight at dusk")).toBeTruthy();
	});

	it("falls back to modality string when prompt is missing", () => {
		const view = makeView({ modality: "image" });
		render(<AssetRender view={view} sessionId="sess-1" />);
		expect(screen.getAllByText(/image/i).length).toBeGreaterThan(0);
	});
});
