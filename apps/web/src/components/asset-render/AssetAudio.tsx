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

import type { ReactElement } from "react";
import type { AssetGenerateView } from "@covel/shared";
import { AudioPlayer } from "@/components/AudioPlayer.js";

export interface AssetAudioProps {
  readonly view: AssetGenerateView;
  readonly sessionId: string;
}

function readPrompt(meta: AssetGenerateView["meta"]): string | null {
  if (!meta) return null;
  const prompt = (meta as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
}

export function AssetAudio({ view, sessionId }: AssetAudioProps): ReactElement {
  const prompt = readPrompt(view.meta);
  const title = prompt ?? view.modality;
  const subtitle = view.source.runtimeId;

  return (
    <figure className="ui-asset-audio flex flex-col gap-1.5 w-full">
      <figcaption className="ui-eyebrow text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80 flex flex-wrap items-baseline gap-x-2">
        <span className="text-foreground/80">{title}</span>
        {subtitle ? <span className="opacity-60">· {subtitle}</span> : null}
      </figcaption>
      <AudioPlayer
        src={view.ref}
        sessionId={sessionId}
        alt={prompt ?? `${view.modality} asset`}
      />
    </figure>
  );
}
