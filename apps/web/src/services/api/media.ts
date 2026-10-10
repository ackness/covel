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

const mediaLibraryKindSchema = z.enum(["image", "audio", "video", "other"]);
export type MediaLibraryKind = z.infer<typeof mediaLibraryKindSchema>;

const mediaLibraryItemSchema = z.object({
  id: z.string().min(1),
  mime: z.string(),
  kind: mediaLibraryKindSchema,
  size: z.number().nonnegative(),
  createdAt: z.string(),
  name: z.string().optional(),
  /**
   * `unused` only when a complete scan found no session that uses the asset;
   * `held` and `unknown` are not unused.
   */
  usage: z.enum(["used", "unused", "held", "unknown"]),
  usedBy: z.array(z.string()),
  url: mediaAccessUrlSchema,
});
export type MediaLibraryItem = z.infer<typeof mediaLibraryItemSchema>;

const mediaLibrarySessionSchema = z.object({
  id: z.string().min(1),
  worldId: z.string().optional(),
  completedPlayerTurns: z.number(),
  createdAt: z.string(),
});
export type MediaLibrarySession = z.infer<typeof mediaLibrarySessionSchema>;

const mediaLibraryPageSchema = z.object({
  items: z.array(mediaLibraryItemSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
  sessions: z.array(mediaLibrarySessionSchema),
  totals: z.object({
    count: z.number(),
    bytes: z.number(),
    unusedCount: z.number(),
    unusedBytes: z.number(),
  }),
  scan: z.object({
    complete: z.boolean(),
    incompleteSessionId: z.string().optional(),
  }),
});
export type MediaLibraryPage = z.infer<typeof mediaLibraryPageSchema>;

const mediaLibraryDeleteResultSchema = z.object({
  deletedIds: z.array(z.string()),
  bytesDeleted: z.number(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type MediaLibraryDeleteResult = z.infer<
  typeof mediaLibraryDeleteResultSchema
>;

export interface MediaLibraryQuery {
  readonly kind?: MediaLibraryKind;
  readonly unusedOnly?: boolean;
  readonly offset: number;
  readonly limit: number;
  /** Scan the sessions again instead of reusing the server's recent scan. */
  readonly refresh?: boolean;
}

/** One page of the media the server stores, with the sessions that use it. */
export async function listMediaLibrary(
  query: MediaLibraryQuery,
  signal?: AbortSignal,
): Promise<MediaLibraryPage> {
  const params = new URLSearchParams({
    offset: String(query.offset),
    limit: String(query.limit),
  });
  if (query.kind) params.set("kind", query.kind);
  if (query.unusedOnly) params.set("usage", "unused");
  if (query.refresh) params.set("refresh", "1");
  return request(`/api/media/library?${params.toString()}`, {
    signal,
    // The pane explains an unavailable library itself.
    silentStatuses: [503],
    schema: mediaLibraryPageSchema,
  });
}

/**
 * Delete stored media. `ids` and `unused` delete only what no session uses;
 * `forceId` deletes one asset whatever uses it.
 */
export async function deleteMediaLibrary(
  target:
    | { readonly ids: readonly string[] }
    | { readonly unused: true }
    | { readonly forceId: string },
): Promise<MediaLibraryDeleteResult> {
  const body =
    "forceId" in target ? { ids: [target.forceId], force: true } : target;
  return request("/api/media/library/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    schema: mediaLibraryDeleteResultSchema,
  });
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
