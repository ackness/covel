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

import { AssetCaption, readAssetPrompt } from "./asset-caption.js";
import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { Media } from "@/components/Media.js";

export interface AssetImageProps {
  readonly view: AssetGenerateView;
  readonly sessionId: string;
}

export function AssetImage({ view, sessionId }: AssetImageProps): ReactElement {
  const prompt = readAssetPrompt(view.meta);
  return (
    <AssetCaption view={view} className="ui-asset-image">
      <Media
        src={view.ref}
        sessionId={sessionId}
        alt={prompt ?? `${view.modality} asset`}
        as="image"
        rounded="md"
      />
    </AssetCaption>
  );
}
