import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { Volume2, VolumeX } from "lucide-react";
import type { StageMusicModel } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { text } from "@/components/world/editor-helpers.js";
import { useBgmPlayer } from "@/hooks/use-bgm-player.js";
import { DEFAULT_FADE_MS } from "@/lib/bgm-player.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { MUSIC_ENABLED_SETTING } from "@/settings/registry/core.js";
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

/** The player's music switch, where a surface has music to switch. */
export function MusicSwitch({
  title,
  className,
  ghost = false,
  t,
}: {
  /** What is playing, added to the tooltip. */
  readonly title?: string;
  readonly className: string;
  /** Drawn as the quiet icon buttons of a toolbar. */
  readonly ghost?: boolean;
  readonly t: TFunction;
}) {
  const [enabled, setEnabled] = useSetting<boolean>(MUSIC_ENABLED_SETTING);
  const label = t(enabled ? "session.musicMute" : "session.musicUnmute");
  const props = {
    className,
    onClick: () => void setEnabled(!enabled),
    "aria-label": label,
    "aria-pressed": enabled,
    title: title ? `${label} — ${title}` : label,
  };
  const icon = enabled ? (
    <Volume2 className="h-4 w-4" />
  ) : (
    <VolumeX className="h-4 w-4" />
  );
  return ghost ? (
    <Button variant="ghost" size="icon" {...props}>
      {icon}
    </Button>
  ) : (
    <button type="button" {...props}>
      {icon}
    </button>
  );
}

/** Turns the music on and off; shown only while the session has a track. */
export function MusicToggle({
  sessionId,
  t,
}: {
  readonly sessionId: string;
  readonly t: TFunction;
}) {
  const music = useSessionMusic(sessionId);
  if (!music) return null;
  return (
    <MusicSwitch
      title={text(music.title)}
      className="ui-session-action h-10 w-10 shrink-0 md:h-8 md:w-8"
      ghost
      t={t}
    />
  );
}
