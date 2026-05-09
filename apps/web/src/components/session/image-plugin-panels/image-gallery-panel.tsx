import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Media } from "@/components/Media.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import {
  compactJobId,
  formatJobDuration,
  jobStatusBadgeVariant,
} from "@/lib/job-ui.js";
import {
  downloadImage,
  findImageGeneratorRuntimeId,
  rerunImagePrompt,
} from "./actions.js";
import { ImagePreviewDialog } from "./image-preview-dialog.js";
import {
  getImageRef,
  parseImageRows,
  type ImageRecord,
} from "./image-records.js";

export function ImageGalleryPanel({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const { state } = useSession();
  const sessionId = state.session?.id;
  const data = usePluginNamespace(pluginId, "images");
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const generatorRuntimeId = useMemo(
    () =>
      findImageGeneratorRuntimeId(
        state.sessionPlugins.find((p) => p.id === pluginId),
      ),
    [pluginId, state.sessionPlugins],
  );
  const images = useMemo(() => parseImageRows(data), [data]);

  if (images.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic text-center leading-relaxed px-4 pt-6">
        {t("coreImage.panel.noImagesYet")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {t("coreImage.panel.galleryHint")}
      </p>
      <div className="grid grid-cols-1 gap-2">
        {images.map(({ key, value }) => {
          const ref = getImageRef(value);
          return (
            <div
              key={key}
              className="rounded-lg border border-border bg-card/60 overflow-hidden"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => ref && setPreview(value)}
                disabled={!ref}
                title={ref ? t("coreImage.panel.viewLarge") : undefined}
              >
                {ref ? (
                  <Media
                    src={ref}
                    sessionId={sessionId ?? ""}
                    alt={value.imageId ?? key}
                    aspectRatio="1/1"
                    rounded="none"
                    fit="cover"
                  />
                ) : (
                  <div className="aspect-square flex items-center justify-center bg-muted text-muted-foreground text-xs">
                    <ImageIcon className="w-4 h-4 mr-1" /> no image
                  </div>
                )}
              </button>
              <div className="p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 min-w-0">
                    <Badge
                      variant={jobStatusBadgeVariant(value.status)}
                      className="text-[9px] h-4 px-1.5"
                    >
                      {value.status ?? "unknown"}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground truncate">
                      {compactJobId(value.imageId ?? key)}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatJobDuration(value.durationMs)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {value.composition && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {value.composition}
                    </Badge>
                  )}
                  {value.model && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {value.model}
                    </Badge>
                  )}
                  {value.imageSize && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {value.imageSize}
                    </Badge>
                  )}
                </div>
                {value.error && (
                  <p className="text-[10px] text-destructive leading-relaxed line-clamp-2">
                    {value.error}
                  </p>
                )}
                <div className="flex gap-1.5">
                  {ref && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[10px] flex-1"
                        onClick={() => setPreview(value)}
                      >
                        <ExternalLink className="w-3 h-3 mr-1" />{" "}
                        {t("coreImage.panel.viewLargeAction")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[10px] flex-1"
                        onClick={() => {
                          downloadImage({
                            ref,
                            sessionId,
                            filename: `${value.imageId ?? key}.png`,
                          });
                        }}
                      >
                        <Download className="w-3 h-3 mr-1" />{" "}
                        {t("coreImage.panel.download")}
                      </Button>
                    </>
                  )}
                  {value.prompt && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[10px] flex-1"
                      onClick={() => {
                        rerunImagePrompt({
                          sessionId,
                          pluginId,
                          runtimeId: generatorRuntimeId,
                          payload: {
                            prompt: value.prompt!,
                            promptMode: value.promptMode ?? "text",
                            composition: value.composition ?? "single-scene",
                          },
                        });
                      }}
                    >
                      {t("coreImage.panel.rerun")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <ImagePreviewDialog
        preview={preview}
        sessionId={sessionId}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
