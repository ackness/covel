import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon } from "lucide-react";
import type { MediaRef, CharacterVisualModel } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import { useActiveSessionId } from "@/lib/catalog/session-context.js";
import { resolveCharacterVisual } from "@/lib/character-visuals.js";

interface PresenceEntry {
  readonly key: string;
  readonly value: CharacterVisualModel;
}

/** Read-only gallery of the portraits that `character.visual@1` projects. */
export function PortraitGalleryPanel() {
  const { t } = useTranslation();
  const sessionId = useActiveSessionId();
  const slots = useUiSlots(sessionId ?? "", "character.visual@1");
  const [preview, setPreview] = useState<MediaRef | null>(null);

  const entries = useMemo<PresenceEntry[]>(
    () =>
      slots.flatMap((slot) =>
        slot.value && slot.key
          ? [{ key: slot.key, value: slot.value as CharacterVisualModel }]
          : [],
      ),
    [slots],
  );

  if (entries.length === 0) {
    return (
      <p className="px-4 pt-6 text-center text-xs italic leading-relaxed text-muted-foreground">
        {t(
          "characterPresence.empty",
          "This world ships no character portraits yet.",
        )}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {t("characterPresence.hint", "Click a portrait to enlarge it.")}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {entries.map((entry) => {
          // Prefer the dedicated full-body 立绘 (sprite) when a world ships one,
          // else fall back to the avatar — so the panel's "立绘" name is truthful
          // and the sprite field a world may provide is actually rendered.
          const ref = resolveCharacterVisual(entry.value)?.ref ?? null;
          return (
            <div key={entry.key} className="space-y-1">
              <div className="group relative overflow-hidden rounded-(--radius-card) border border-border bg-card/60 transition-colors hover:border-primary/40">
                <button
                  type="button"
                  className="block w-full cursor-zoom-in disabled:cursor-default"
                  onClick={() => ref && setPreview(ref)}
                  disabled={!ref}
                  aria-label={t(
                    "characterPresence.enlarge",
                    "Enlarge portrait",
                  )}
                >
                  {ref ? (
                    <Media
                      src={ref}
                      sessionId={sessionId}
                      alt={entry.value.displayName ?? ""}
                      aspectRatio="3/4"
                      rounded="none"
                      fit="cover"
                    />
                  ) : (
                    <div className="flex aspect-3/4 items-center justify-center text-muted-foreground/50">
                      <ImageIcon className="h-5 w-5" />
                    </div>
                  )}
                </button>
              </div>
              <span className="block truncate text-xs text-muted-foreground">
                {entry.value.displayName}
              </span>
            </div>
          );
        })}
      </div>
      <MediaPreviewDialog
        mediaRef={preview}
        sessionId={sessionId}
        aspectRatio="3/4"
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
