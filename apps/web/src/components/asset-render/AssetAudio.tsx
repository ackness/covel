/**
 * `<AssetAudio>` — default renderer for `asset.generate{ modality: 'audio' }`.
 *
 * Mirrors `<AssetImage>` for the audio modality: a small caption strip above
 * a theme-aware `<AudioPlayer>` (replaces the previous native
 * `<audio controls>` chrome which never inherited theme tokens).
 * `<AudioPlayer>` handles MediaRef resolution + blob-cache for us.
 *
 * SPEC §5.7 — modality routing default for `'audio'`.
 */

import { AssetCaption, readAssetPrompt } from "./asset-caption.js";
import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { AudioPlayer } from "@/components/AudioPlayer.js";

export interface AssetAudioProps {
  readonly view: AssetGenerateView;
  readonly sessionId: string;
}

export function AssetAudio({ view, sessionId }: AssetAudioProps): ReactElement {
  const prompt = readAssetPrompt(view.meta);
  return (
    <AssetCaption view={view} className="ui-asset-audio">
      <AudioPlayer
        src={view.ref}
        sessionId={sessionId}
        alt={prompt ?? `${view.modality} asset`}
      />
    </AssetCaption>
  );
}
