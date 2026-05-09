import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Media } from "@/components/Media.js";
import { downloadImage } from "./actions.js";
import type { ImageRecord } from "./image-records.js";

interface ImagePreviewDialogProps {
  readonly preview: ImageRecord | null;
  readonly sessionId: string | undefined;
  readonly onClose: () => void;
}

export function ImagePreviewDialog({
  preview,
  sessionId,
  onClose,
}: ImagePreviewDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-xs">
            {preview?.imageId}
          </DialogTitle>
        </DialogHeader>
        {preview?.ref && (
          <div className="space-y-3">
            <Media
              src={preview.ref}
              sessionId={sessionId ?? ""}
              alt={preview.imageId ?? "image"}
              aspectRatio="1/1"
              rounded="md"
              fit="contain"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!preview?.ref) return;
                  downloadImage({
                    ref: preview.ref,
                    sessionId,
                    filename: `${preview.imageId}.png`,
                  });
                }}
              >
                <Download className="w-3 h-3 mr-1" />{" "}
                {t("coreImage.panel.downloadImage")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
