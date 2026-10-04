import { useEffect, useRef, type RefObject } from "react";
import { BgmPlayer } from "@/lib/bgm-player.js";
import {
  MUSIC_ENABLED_SETTING,
  MUSIC_VOLUME_SETTING,
} from "@/settings/registry/core.js";
import { useSetting } from "@/settings/use-settings.js";

/**
 * A background-music player that lives as long as `scope` does (a session, a
 * world list) and follows the player's music switch and volume. Call it before
 * the effects that give the player its track: they need the player to exist.
 */
export function useBgmPlayer(scope: string): RefObject<BgmPlayer | null> {
  const [enabled] = useSetting<boolean>(MUSIC_ENABLED_SETTING);
  const [volume] = useSetting<number>(MUSIC_VOLUME_SETTING);
  const playerRef = useRef<BgmPlayer | null>(null);

  useEffect(() => {
    const player = new BgmPlayer();
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [scope]);

  useEffect(() => {
    playerRef.current?.setMuted(!enabled);
  }, [enabled, scope]);
  useEffect(() => {
    playerRef.current?.setLevel(volume / 100);
  }, [volume, scope]);

  return playerRef;
}
