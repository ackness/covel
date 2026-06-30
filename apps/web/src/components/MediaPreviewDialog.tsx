/**
 * `MediaPreviewDialog` — generic click-to-enlarge dialog for any `MediaRef`.
 *
 * Extracted from the image-generation gallery's preview so character portraits,
 * avatar badges, and generated images all share one enlarge + download surface.
 * Open state is driven by `mediaRef` (null = closed) so callers can keep a
 * single `const [zoom, setZoom] = useState<MediaRef | null>(null)`.
 */

import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MediaRef } from "@covel/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Media } from "@/components/Media.js";
import { downloadImage } from "@/components/session/image-plugin-panels/actions.js";

interface MediaPreviewDialogProps {
  /** The media to show enlarged, or `null` to keep the dialog closed. */
  readonly mediaRef: MediaRef | null;
  readonly sessionId: string | undefined;
  /** Optional heading + default download filename stem. */
  readonly title?: string;
  /** Container aspect-ratio for the enlarged `fit="contain"` image. Default `"1/1"`. */
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
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">{title ?? ""}</DialogTitle>
        </DialogHeader>
        {mediaRef && (
          <div className="space-y-3">
            <Media
              src={mediaRef}
              sessionId={sessionId ?? ""}
              alt={title ?? ""}
              aspectRatio={aspectRatio}
              rounded="md"
              fit="contain"
              maxHeight="80vh"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadImage({
                    ref: mediaRef,
                    sessionId,
                    filename: `${title || "image"}.png`,
                  })
                }
              >
                <Download className="w-3 h-3 mr-1" />{" "}
                {t("coreImage.panel.downloadImage", "Download")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
