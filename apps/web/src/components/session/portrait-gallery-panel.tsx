import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, Loader2, Upload } from "lucide-react";
import type { MediaRef } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useActiveSessionId } from "@/lib/catalog/session-context.js";
import { postPluginRpc, uploadSessionMedia } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";

interface PresenceRecord {
  readonly characterId?: string;
  readonly displayName?: string;
  readonly avatar?: unknown;
}

interface PresenceEntry {
  readonly key: string;
  readonly value: PresenceRecord;
}

/**
 * PortraitGalleryPanel — player-facing character portrait gallery.
 *
 * Shows each character's portrait as a framed, click-to-enlarge thumbnail, and
 * lets the player replace it by picking an image file. The file is uploaded as
 * session-owned media (`uploadSessionMedia`), then the resulting `MediaRef` is
 * written back as the character's presence via the plugin's own runtime
 * (`postPluginRpc` → `presence` payload) — no sha256 / MIME / size hand-entry.
 *
 * `pluginId` comes from the panel spec (the plugin names itself), so this stays
 * a generic framework component with no hard-coded plugin id.
 */
export function PortraitGalleryPanel({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const sessionId = useActiveSessionId();
  const presence = usePluginNamespace(pluginId, "presence");
  const [preview, setPreview] = useState<MediaRef | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);

  const entries = useMemo<PresenceEntry[]>(
    () =>
      Object.entries(presence).map(([key, value]) => ({
        key,
        value: (value ?? {}) as PresenceRecord,
      })),
    [presence],
  );

  async function replacePortrait(entry: PresenceEntry, file: File) {
    const characterId = entry.value.characterId;
    if (!sessionId || !characterId) return;
    setUploadingKey(entry.key);
    try {
      const ref = await uploadSessionMedia(sessionId, file);
      await postPluginRpc(sessionId, {
        pluginId,
        runtimeId: pluginId,
        payload: {
          presence: {
            schemaVersion: 1,
            characterId,
            ...(entry.value.displayName
              ? { displayName: entry.value.displayName }
              : {}),
            avatar: { id: ref.id, mime: ref.mime, size: ref.size },
            sprite: { id: ref.id, mime: ref.mime, size: ref.size },
          },
        },
      });
      // The plugin.data commit emits `plugin-data.changed`, which refreshes the
      // presence store and re-renders this gallery with the new portrait.
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingKey(null);
    }
  }

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
        {t(
          "characterPresence.hint",
          "Click a portrait to enlarge, or hover and pick an image to replace it.",
        )}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {entries.map((entry) => {
          const ref = isMediaRef(entry.value.avatar)
            ? entry.value.avatar
            : null;
          const busy = uploadingKey === entry.key;
          return (
            <div key={entry.key} className="space-y-1">
              <div className="group relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-card/60 transition-colors hover:border-primary/40">
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
                    <div className="flex aspect-[3/4] items-center justify-center text-muted-foreground/50">
                      <ImageIcon className="h-5 w-5" />
                    </div>
                  )}
                </button>
                <label className="absolute inset-x-0 bottom-0 flex cursor-pointer items-center justify-center gap-1 bg-black/60 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  {busy
                    ? t("characterPresence.uploading", "Uploading…")
                    : t("characterPresence.replace", "Replace")}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void replacePortrait(entry, file);
                    }}
                  />
                </label>
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
