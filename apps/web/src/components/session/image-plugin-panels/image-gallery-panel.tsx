import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, ImageIcon } from "lucide-react";
import { mediaGalleryPropsSchema } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { Media } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import {
  catalogItems,
  invokeCatalogAction,
} from "@/lib/catalog/catalog-actions.js";
import { resolvePath, useI18nResolver } from "@/lib/catalog/helpers.js";
import { useActiveSessionId } from "@/lib/catalog/session-context.js";
import { emitToast } from "@/lib/toast-channel.js";
import { formatJobDuration } from "@/lib/job-ui.js";
import { downloadImage } from "./actions.js";

export function MediaGalleryPanel({
  props: input,
}: {
  props: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const sessionId = useActiveSessionId();
  const [preview, setPreview] = useState<MediaRef | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = mediaGalleryPropsSchema.safeParse(input);
  if (!parsed.success) return null;
  const props = parsed.data;
  const items = catalogItems(props.items);
  if (!items.length)
    return (
      <p className="text-xs text-muted-foreground italic text-center px-4 pt-6">
        {resolve(input.emptyText) || t("coreImage.panel.noImagesYet")}
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2">
        {items.map((item, index) => {
          const value = resolvePath(item, props.refField);
          const ref = isMediaRef(value) ? value : null;
          const id = String(resolvePath(item, props.idField) ?? index);
          const title = String(
            props.titleField ? (resolvePath(item, props.titleField) ?? id) : id,
          );
          const error = props.errorField && resolvePath(item, props.errorField);
          const status =
            props.statusField && resolvePath(item, props.statusField);
          const duration =
            props.durationField && resolvePath(item, props.durationField);
          return (
            <div
              key={id}
              className="image-gallery-row rounded-lg border border-border bg-card/60 overflow-hidden"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => ref && setPreview(ref)}
                disabled={!ref}
              >
                {ref ? (
                  <Media
                    src={ref}
                    sessionId={sessionId}
                    alt={title}
                    aspectRatio="1/1"
                    rounded="none"
                    fit="cover"
                  />
                ) : (
                  <div className="aspect-square flex items-center justify-center text-muted-foreground">
                    <ImageIcon className="w-4 h-4" />
                  </div>
                )}
              </button>
              <div className="p-2 space-y-2">
                <div className="flex justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{title}</span>
                  {status ? <span>{String(status)}</span> : null}
                  {typeof duration === "number" ? (
                    <span>{formatJobDuration(duration)}</span>
                  ) : null}
                </div>
                {props.fields?.map((field) => {
                  const value = resolvePath(item, field.path);
                  return value == null ? null : (
                    <p
                      key={field.path}
                      className="text-[11px] text-muted-foreground whitespace-pre-wrap"
                    >
                      {resolve(field.label)} {String(value)}
                    </p>
                  );
                })}
                {error ? (
                  <p className="text-[10px] text-destructive">
                    {String(error)}
                  </p>
                ) : null}
                <div className="flex gap-1.5">
                  {ref ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreview(ref)}
                      >
                        <ExternalLink className="w-3 h-3" />
                        {t("coreImage.panel.viewLargeAction")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          downloadImage({
                            ref,
                            sessionId,
                            filename: `${id}.png`,
                          })
                        }
                      >
                        <Download className="w-3 h-3" />
                        {t("coreImage.panel.download")}
                      </Button>
                    </>
                  ) : null}
                  {props.rerunAction ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !sessionId}
                      onClick={() => {
                        if (!sessionId || !props.rerunAction) return;
                        setBusy(true);
                        void invokeCatalogAction({
                          sessionId,
                          action: props.rerunAction,
                          scope: { item, props: input },
                          t,
                        })
                          .catch((err) => emitToast("error", String(err)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      {resolve(props.rerunAction.label) ||
                        t("coreImage.panel.rerun")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <MediaPreviewDialog
        mediaRef={preview}
        sessionId={sessionId}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
