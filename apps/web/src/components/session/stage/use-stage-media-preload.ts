/**
 * Warm the IDB media cache with the stage art the session is known to need
 * — character sprites/avatars (character-presence `presence`) and world
 * scene backdrops (scene-stage `scenes` registry) — as soon as the session
 * opens, instead of on first `<Media>` mount (StageView only mounts once
 * `phase === "playing"`, so without this every image download starts after the
 * pre-game turn fully ends). World-package media bytes are imported into
 * the MediaStore at session creation, so pre-fetching during turn 0 is
 * pure cache warm-up: when the opening turn lands, backdrops and sprites
 * resolve from IDB instantly.
 */
import { useEffect, useRef } from "react";
import { FrameworkCapability, type MediaRef } from "@covel/shared";
import { listPluginData } from "@/services/api/plugin-data.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import {
  collectCharacterVisualRefs,
  type PresenceRecord,
} from "@/lib/character-visuals.js";
import {
  loadPluginDataForSession,
  usePluginNamespace,
} from "@/stores/plugin-data-store.js";
import { pluginIdForCapability } from "./stage-selectors.js";

interface CapabilityCarrier {
  readonly id: string;
  readonly active?: boolean;
  readonly capabilities?: readonly string[];
}

/** Sequentially resolve (and thus IDB-cache) each image ref, skipping ids
 * already warmed this mount. `resolveMediaSrc` never throws; the blob URL
 * it mints is revoked immediately — only the cached bytes matter here. */
async function warmRefs(
  sessionId: string,
  refs: readonly MediaRef[],
  warmed: Set<string>,
): Promise<void> {
  for (const ref of refs) {
    if (!ref.mime.startsWith("image/") || warmed.has(ref.id)) continue;
    warmed.add(ref.id);
    const result = await resolveMediaSrc(ref, { sessionId });
    if (result.url.startsWith("blob:")) URL.revokeObjectURL(result.url);
  }
}

export function useStageMediaPreload(
  sessionId: string,
  sessionPlugins: readonly CapabilityCarrier[],
): void {
  const presenceId =
    pluginIdForCapability(
      sessionPlugins,
      FrameworkCapability.CharacterPresence,
    ) ?? "";
  const sceneStageId =
    pluginIdForCapability(sessionPlugins, FrameworkCapability.SceneStage) ?? "";

  // presence is hydrated at session open and updated over SSE, so this
  // effect re-fires as new records (e.g. pre-game generated portraits) land.
  const presence = usePluginNamespace(presenceId, "presence");
  const warmed = useRef<Set<string>>(new Set());

  useEffect(() => {
    const refs: MediaRef[] = [];
    for (const value of Object.values(presence)) {
      refs.push(...collectCharacterVisualRefs(value as PresenceRecord));
    }
    void warmRefs(sessionId, refs, warmed.current);
  }, [sessionId, presence]);

  // The scene registry is not referenced by any panel spec, so plugin-data
  // hydration never loads it into the store — fetch it once directly.
  useEffect(() => {
    if (!sceneStageId) return;
    let cancelled = false;
    listPluginData(sessionId, sceneStageId, "scenes")
      .then((rows) => {
        if (cancelled) return;
        // The same fetch also hydrates the registry slice used by the
        // scene.set preview selector, so a validated location change can
        // resolve world art immediately instead of waiting for commit.
        loadPluginDataForSession(sessionId, sceneStageId, "scenes", rows);
        const refs: MediaRef[] = [];
        for (const row of rows) {
          const scenes = (row.value as { scenes?: unknown } | null)?.scenes;
          if (!Array.isArray(scenes)) continue;
          for (const scene of scenes as ReadonlyArray<{
            day?: unknown;
            night?: unknown;
          }>) {
            if (isMediaRef(scene?.day)) refs.push(scene.day);
            if (isMediaRef(scene?.night)) refs.push(scene.night);
          }
        }
        void warmRefs(sessionId, refs, warmed.current);
      })
      .catch((err: unknown) => {
        console.warn("[stage-preload] scene registry fetch failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sceneStageId]);
}
