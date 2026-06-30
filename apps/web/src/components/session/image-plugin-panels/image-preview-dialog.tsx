import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import type { ImageRecord } from "./image-records.js";

interface ImagePreviewDialogProps {
  readonly preview: ImageRecord | null;
  readonly sessionId: string | undefined;
  readonly onClose: () => void;
}

/**
 * Image-generation gallery preview — a thin adapter over the generic
 * {@link MediaPreviewDialog}, mapping an `ImageRecord` to its `MediaRef`.
 */
export function ImagePreviewDialog({
  preview,
  sessionId,
  onClose,
}: ImagePreviewDialogProps) {
  return (
    <MediaPreviewDialog
      mediaRef={preview?.ref ?? null}
      sessionId={sessionId}
      title={preview?.imageId}
      onClose={onClose}
    />
  );
}
