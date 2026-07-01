import type { MediaRef } from "@covel/shared";

/**
 * Upload an image file as session-owned media. Posts the raw bytes to
 * `POST /api/media?sessionId=…` (Content-Type = the file's MIME); the server
 * content-addresses it and records the session as owner + ref so the session's
 * signed media-token can read it back. Returns the resulting `MediaRef`.
 */
export async function uploadSessionMedia(
  sessionId: string,
  file: File,
): Promise<MediaRef> {
  const res = await fetch(
    `/api/media?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status})${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as MediaRef;
}
