/**
 * `MediaPreviewDialog` — generic click-to-enlarge lightbox for any `MediaRef`.
 *
 * Extracted from the image-generation gallery's preview so character portraits,
 * avatar badges, and generated images all share one enlarge + download surface.
 * Open state is driven by `mediaRef` (null = closed) so callers can keep a
 * single `const [zoom, setZoom] = useState<MediaRef | null>(null)`.
 *
 * Layout is a tight lightbox: the dialog hugs the image (`w-auto`) over a subtle
 * dark mat, with a compact footer holding the title + download on one line — so
 * a tall portrait doesn't leave a wide empty dialog around it.
 */

import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MediaRef } from "@covel/shared";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Media } from "@/components/Media.js";
import { downloadImage } from "@/components/session/image-plugin-panels/actions.js";

interface MediaPreviewDialogProps {
  /** The media to show enlarged, or `null` to keep the dialog closed. */
  readonly mediaRef: MediaRef | null;
  readonly sessionId: string | undefined;
  /** Optional heading + default download filename stem. */
  readonly title?: string;
  /** Aspect-ratio for the loading/error placeholder only. Default `"1/1"`. */
  readonly aspectRatio?: string;
  readonly onClose: () => void;
}

export function MediaPreviewDialog({
  mediaRef,
  sessionId,
  title,
  aspectRatio = "1/1",
  onClose,
}: MediaPreviewDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={mediaRef !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="flex w-auto max-w-[95vw] max-h-[92vh] flex-col gap-0 overflow-hidden p-0">
        {mediaRef ? (
          <>
            <div className="flex min-h-0 items-center justify-center bg-black/40 p-3">
              <Media
                src={mediaRef}
                sessionId={sessionId ?? ""}
                alt={title ?? ""}
                aspectRatio={aspectRatio}
                rounded="md"
                fit="contain"
                maxHeight="76vh"
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
              <DialogTitle
                className={title ? "truncate text-sm font-medium" : "sr-only"}
              >
                {title || t("common.preview", "Preview")}
              </DialogTitle>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() =>
                  downloadImage({
                    ref: mediaRef,
                    sessionId,
                    filename: `${title || "image"}.png`,
                  })
                }
              >
                <Download className="mr-1 h-3 w-3" />{" "}
                {t("coreImage.panel.downloadImage", "Download")}
              </Button>
            </div>
          </>
        ) : (
          <DialogTitle className="sr-only">
            {t("common.preview", "Preview")}
          </DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}
