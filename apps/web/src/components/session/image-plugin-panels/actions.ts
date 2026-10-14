import type { TFunction } from "i18next";
import type { MediaRef } from "@covel/shared";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { emitToast } from "@/lib/toast-channel.js";

async function downloadRef(
  ref: MediaRef,
  sessionId: string | undefined,
  filename: string,
  t: TFunction,
): Promise<void> {
  if (!sessionId) throw new Error(t("coreImage.sessionUnavailable"));
  const resolved = await resolveMediaSrc(ref, { sessionId });
  if (!resolved.ok || !resolved.url)
    throw new Error(t("coreImage.mediaUnavailable"));
  const a = document.createElement("a");
  a.href = resolved.url;
  a.download = filename;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    if (resolved.url.startsWith("blob:")) URL.revokeObjectURL(resolved.url);
  }
}

function showActionError(err: unknown, t: TFunction): void {
  emitToast("error", err instanceof Error ? err.message : t("common.error"));
}

export function downloadMedia(args: {
  readonly ref: MediaRef;
  readonly sessionId: string | undefined;
  readonly filenameStem: string;
  readonly t: TFunction;
}): void {
  void downloadRef(
    args.ref,
    args.sessionId,
    `${args.filenameStem}.${mediaExtension(args.ref.mime)}`,
    args.t,
  ).catch((err) => showActionError(err, args.t));
}

/** Unknown formats stay binary; never label their bytes as an image. */
function mediaExtension(mime: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/pcm": "pcm",
    "audio/l16": "pcm",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  const type = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return Object.hasOwn(extensions, type) ? extensions[type]! : "bin";
}
