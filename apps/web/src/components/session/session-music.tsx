import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import type { StageMusicModel } from "@covel/shared";
import { text } from "@/components/world/editor-helpers.js";
import { useBgmPlayer } from "@/hooks/use-bgm-player.js";
import { DEFAULT_FADE_MS } from "@/lib/bgm-player.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import {
  MUSIC_ENABLED_SETTING,
  MUSIC_VOLUME_SETTING,
} from "@/settings/registry/core.js";
import { useSetting } from "@/settings/use-settings.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";

/**
 * The music plugins ask for through the `stage.music@1` slot, when there is a
 * track to play. Which track, and why, is the plugins' business; the app only
 * plays what the slot holds.
 */
function useSessionMusic(sessionId: string): StageMusicModel | null {
  const music = useUiSlot(sessionId, "stage.music@1")?.value as
    StageMusicModel | null | undefined;
  return music?.ref ? music : null;
}

/** Plays the session's music; draws nothing. */
export function SessionMusic({ sessionId }: { readonly sessionId: string }) {
  const music = useSessionMusic(sessionId);
  const playerRef = useBgmPlayer(sessionId);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    };
  }, [sessionId]);

  const ref = music?.ref;
  const key = music ? (music.trackId ?? ref?.id) : undefined;
  const loop = music?.loop !== false;
  const trackVolume = music?.volume ?? 1;
  const fadeMs = music?.fadeMs ?? DEFAULT_FADE_MS;
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!ref || !key) {
      player.play(null);
      return;
    }
    const controller = new AbortController();
    void resolveMediaSrc(ref, { sessionId, signal: controller.signal }).then(
      (resolved) => {
        if (!resolved.ok) return;
        urlsRef.current.push(resolved.url);
        if (controller.signal.aborted) return;
        player.play({
          key,
          url: resolved.url,
          loop,
          volume: trackVolume,
          fadeMs,
        });
      },
    );
    return () => controller.abort();
    // The asset is named by its id; a new object for the same id is the same track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, key, ref?.id, loop, trackVolume, fadeMs]);

  return null;
}

/**
 * Music switch and volume for the session menu, shown only while the session
 * has a track. Both settings apply to every game.
 */
export function MusicMenuControls({
  sessionId,
  t,
}: {
  readonly sessionId: string;
  readonly t: TFunction;
}) {
  const music = useSessionMusic(sessionId);
  const [enabled, setEnabled] = useSetting<boolean>(MUSIC_ENABLED_SETTING);
  const [volume, setVolume] = useSetting<number>(MUSIC_VOLUME_SETTING);
  if (!music) return null;
  const title = text(music.title);
  return (
    <div
      className="space-y-1.5 px-2.5 py-1.5 text-[13px]"
      // Adjusting music must not close the menu.
      onClick={(event) => event.stopPropagation()}
    >
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(event) => void setEnabled(event.target.checked)}
        />
        <span>{t("session.musicAllGames")}</span>
      </label>
      {title && (
        <p className="truncate pl-6 text-xs text-muted-foreground">{title}</p>
      )}
      <label className="flex items-center gap-2.5 text-xs text-muted-foreground">
        <span className="shrink-0">{t("session.musicVolume")}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          disabled={!enabled}
          onChange={(event) => void setVolume(Number(event.target.value))}
          aria-label={t("session.musicVolume")}
          className="min-w-0 flex-1"
        />
      </label>
    </div>
  );
}
