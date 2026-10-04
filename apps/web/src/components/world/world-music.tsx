import { useEffect, useRef } from "react";
import type { WorldRecord } from "@/services/api.js";
import { useBgmPlayer } from "@/hooks/use-bgm-player.js";
import { DEFAULT_FADE_MS } from "@/lib/bgm-player.js";
import { useWorldThemeMusicUrl } from "./world-gallery.js";

/**
 * Plays the music a world names for the world list (`themeMusic` in
 * `world.yaml`) while that world is the one shown, and says whether it has
 * any. The music of a session is another matter: plugins choose it.
 */
export function useWorldThemeMusic(
  world: WorldRecord | null | undefined,
): boolean {
  const url = useWorldThemeMusicUrl(world);
  const playerRef = useBgmPlayer("world-list");
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const blobUrl of urls.splice(0)) URL.revokeObjectURL(blobUrl);
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!url) {
      player.play(null);
      return;
    }
    const controller = new AbortController();
    // Read whole and played from memory: the file route answers without
    // byte ranges, which some browsers need to play from a URL.
    void fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || controller.signal.aborted) return;
        const blobUrl = URL.createObjectURL(blob);
        urlsRef.current.push(blobUrl);
        player.play({
          key: url,
          url: blobUrl,
          loop: true,
          volume: 1,
          fadeMs: DEFAULT_FADE_MS,
        });
      })
      .catch(() => {
        // A theme that cannot be read is silence, not an error on the list.
      });
    return () => controller.abort();
  }, [url, playerRef]);

  return Boolean(url);
}
