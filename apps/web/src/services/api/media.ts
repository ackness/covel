import { z } from "zod";
import type { MediaRef } from "@covel/shared";
import { request } from "./request.js";

const mediaAccessUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.startsWith("/") && !value.startsWith("//")) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be a same-origin path or an HTTP(S) URL");

const mediaTokenResponseSchema = z
  .object({ url: mediaAccessUrlSchema })
  .strict();

export function mediaTokenEndpoint(sessionId: string, mediaId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/media-token?id=${encodeURIComponent(mediaId)}`;
}

/** Resolve a session-authorized, short-lived URL for one media asset. */
export async function fetchSessionMediaUrl(
  sessionId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await request(mediaTokenEndpoint(sessionId, mediaId), {
    signal,
    silentErrors: true,
    schema: mediaTokenResponseSchema,
  });
  return response.url;
}

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
  return request<MediaRef>(
    `/api/media?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
      sessionId,
    },
  );
}
