import { useEffect, useRef } from "react";
import type {
  MediaRef,
  CharacterVisualModel,
  StageBackdropModel,
} from "@covel/shared";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { collectCharacterVisualRefs } from "@/lib/character-visuals.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";

/** Warm projected visual catalogs while opening/setup UI is still displayed. */
export function useStageMediaPreload(
  sessionId: string,
  _sessionPlugins?: readonly unknown[],
): void {
  const slots = useUiSlots(sessionId);
  const warmed = useRef({ sessionId, ids: new Set<string>() });
  if (warmed.current.sessionId !== sessionId)
    warmed.current = { sessionId, ids: new Set() };
  useEffect(() => {
    let stopped = false;
    const refs: MediaRef[] = [];
    for (const slot of slots) {
      if (slot.slot === "character.visual@1")
        refs.push(
          ...collectCharacterVisualRefs(
            slot.value as CharacterVisualModel | undefined,
          ),
        );
      if (slot.slot === "stage.backdrop@1") {
        const value = slot.value as StageBackdropModel | undefined;
        refs.push(...(value?.preload ?? []));
        if (value?.ref) refs.push(value.ref);
      }
    }
    const ids = warmed.current.ids;
    void (async () => {
      for (const ref of refs) {
        if (stopped) break;
        if (!ref.mime.startsWith("image/") || ids.has(ref.id)) continue;
        ids.add(ref.id);
        const result = await resolveMediaSrc(ref, { sessionId });
        if (result.url.startsWith("blob:")) URL.revokeObjectURL(result.url);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [sessionId, slots]);
}
