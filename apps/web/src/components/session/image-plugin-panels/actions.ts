import type { MediaRef } from "@covel/shared";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { emitToast } from "@/lib/toast-channel.js";

async function downloadRef(
  ref: MediaRef,
  sessionId: string | undefined,
  filename: string,
): Promise<void> {
  if (!sessionId) throw new Error("session unavailable");
  const resolved = await resolveMediaSrc(ref, { sessionId });
  if (!resolved.ok || !resolved.url) throw new Error("media unavailable");
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

function showActionError(err: unknown): void {
  emitToast("error", err instanceof Error ? err.message : String(err));
}

export function downloadImage(args: {
  readonly ref: MediaRef;
  readonly sessionId: string | undefined;
  readonly filename: string;
}): void {
  void downloadRef(args.ref, args.sessionId, args.filename).catch(
    showActionError,
  );
}
