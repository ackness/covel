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

export function downloadImage(args: {
  readonly ref: MediaRef;
  readonly sessionId: string | undefined;
  readonly filename: string;
  readonly t: TFunction;
}): void {
  void downloadRef(args.ref, args.sessionId, args.filename, args.t).catch(
    (err) => showActionError(err, args.t),
  );
}
