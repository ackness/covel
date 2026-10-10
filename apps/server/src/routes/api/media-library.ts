/**
 * The player's media library: what the MediaStore holds, which sessions use
 * each asset, and deletion on the player's request.
 *
 *   GET  /api/media/library         paged listing with usage and totals
 *   POST /api/media/library/delete  delete chosen assets, or every unused one
 *
 * Nothing here deletes on its own. An asset is deleted without further
 * question only while no current session uses it; one that a session still
 * uses is deleted one at a time and only when the request says `force`.
 *
 * The routes exist only where one player owns everything the server stores
 * (`DEPLOYMENT_TIER=self`, desktop). Hosted tiers and the browser-private
 * profile share the MediaStore between owners and keep no per-owner media
 * index, so they answer `503`.
 */

import { compareText } from "@covel/shared";
import type { Context, Hono } from "hono";
import type { DataStore, MediaStore, SessionRecord } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { signMediaTokenForSession } from "../../middleware/media-token.js";
import { isSessionOwnerAuthEnforced } from "./session/session-guard.js";
import {
  scanMediaReferences,
  type MediaReferenceScan,
} from "./media-reference-scan.js";

/**
 * `sessionId` carried by the signed URLs of the library listing. The colon is
 * outside the session-ID alphabet, so no session can have this ID.
 */
export const MEDIA_LIBRARY_TOKEN_SCOPE = "media-library:";

/** Long enough for a page of lazily loaded tiles to stay readable. */
const LIBRARY_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Per-session row ceiling of a library scan. Far above the cleanup
 * endpoint's default because a played session has tens of thousands of trace
 * rows; a session above it leaves the scan incomplete, and an incomplete scan
 * marks nothing as unused.
 */
const LIBRARY_SCAN_LIMIT_PER_SESSION = 200_000;

/** How long one scan answers listing requests (paging, filters). */
const LIBRARY_SCAN_TTL_MS = 30_000;

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
const MAX_DELETE_IDS = 1_000;

const MEDIA_KINDS = ["image", "audio", "video", "other"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * `used`: a current session uses it. `unused`: a complete scan found no user.
 * `held`: no current session uses it, but something that is not a current
 * session still claims it (an import in progress, or a claim left behind).
 * `unknown`: the scan was incomplete and found no user.
 */
type MediaUsage = "used" | "unused" | "held" | "unknown";

interface LibraryEntry {
  readonly id: string;
  readonly mime: string;
  readonly kind: MediaKind;
  readonly size: number;
  readonly createdAt: string;
  /** File name of an imported asset, when the producer recorded one. */
  readonly name?: string;
  readonly usage: MediaUsage;
  readonly usedBy: readonly string[];
}

interface KindTotals {
  count: number;
  bytes: number;
  unusedCount: number;
  unusedBytes: number;
}

interface LibrarySnapshot {
  readonly scannedAt: string;
  readonly scanLimit: number;
  readonly complete: boolean;
  readonly incompleteSessionId?: string;
  /** Newest first. */
  readonly entries: readonly LibraryEntry[];
  readonly sessions: ReadonlyMap<string, SessionRecord>;
  readonly totals: KindTotals & {
    readonly byKind: Readonly<Record<MediaKind, KindTotals>>;
  };
}

export function isMediaLibraryAvailable(c: Context): boolean {
  return !isSessionOwnerAuthEnforced(c);
}

function mediaKind(mime: string): MediaKind {
  const type = mime.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return "other";
}

function usageOf(scan: MediaReferenceScan, id: string): MediaUsage {
  if ((scan.usedBy.get(id)?.size ?? 0) > 0) return "used";
  if (scan.heldIds.has(id)) return "held";
  // A session that could not be read to the end may use any asset.
  return scan.limitExceeded ? "unknown" : "unused";
}

function emptyTotals(): KindTotals {
  return { count: 0, bytes: 0, unusedCount: 0, unusedBytes: 0 };
}

function buildSnapshot(
  scan: MediaReferenceScan,
  scanLimit: number,
): LibrarySnapshot {
  const totals = emptyTotals();
  const byKind: Record<MediaKind, KindTotals> = {
    image: emptyTotals(),
    audio: emptyTotals(),
    video: emptyTotals(),
    other: emptyTotals(),
  };
  const entries = scan.assets.map((asset): LibraryEntry => {
    const kind = mediaKind(asset.mime);
    const usage = usageOf(scan, asset.id);
    for (const bucket of [totals, byKind[kind]]) {
      bucket.count += 1;
      bucket.bytes += asset.size;
      if (usage === "unused") {
        bucket.unusedCount += 1;
        bucket.unusedBytes += asset.size;
      }
    }
    const name = asset.meta?.filename;
    return {
      id: asset.id,
      mime: asset.mime,
      kind,
      size: asset.size,
      createdAt: asset.createdAt,
      ...(typeof name === "string" && name ? { name } : {}),
      usage,
      usedBy: [...(scan.usedBy.get(asset.id) ?? [])].sort(),
    };
  });
  entries.sort((a, b) => {
    const byCreated = compareText(b.createdAt, a.createdAt);
    return byCreated === 0 ? compareText(a.id, b.id) : byCreated;
  });
  return {
    scannedAt: new Date().toISOString(),
    scanLimit,
    complete: !scan.limitExceeded,
    ...(scan.limitExceededSessionId
      ? { incompleteSessionId: scan.limitExceededSessionId }
      : {}),
    entries,
    sessions: new Map(scan.sessions.map((session) => [session.id, session])),
    totals: { ...totals, byKind },
  };
}

interface CachedSnapshot {
  readonly expiresAt: number;
  readonly scanLimit: number;
  readonly snapshot: Promise<LibrarySnapshot>;
}

/**
 * One scan per MediaStore answers every listing request for a short time.
 * Deletion never reads it: it scans again, then drops it.
 */
const snapshots = new WeakMap<MediaStore, CachedSnapshot>();

function librarySnapshot(
  store: DataStore,
  mediaStore: MediaStore,
  scanLimit: number,
  refresh: boolean,
): Promise<LibrarySnapshot> {
  const cached = snapshots.get(mediaStore);
  if (
    !refresh &&
    cached &&
    cached.scanLimit === scanLimit &&
    cached.expiresAt > Date.now()
  ) {
    return cached.snapshot;
  }
  const snapshot = scanMediaReferences(store, mediaStore, {
    maxScanRowsPerSession: scanLimit,
  }).then((scan) => buildSnapshot(scan, scanLimit));
  const entry: CachedSnapshot = {
    expiresAt: Date.now() + LIBRARY_SCAN_TTL_MS,
    scanLimit,
    snapshot,
  };
  snapshots.set(mediaStore, entry);
  // A failed scan must not answer the next request.
  snapshot.catch(() => {
    if (snapshots.get(mediaStore) === entry) snapshots.delete(mediaStore);
  });
  return snapshot;
}

function parsePositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function unavailable(c: Context): Response {
  return c.json(
    errorBody("media library is not available in this deployment", {
      code: "unavailable",
    }),
    503,
  );
}

function invalid(c: Context, message: string): Response {
  return c.json(errorBody(message, { code: "invalid_request" }), 400);
}

function sessionSummary(session: SessionRecord) {
  return {
    id: session.id,
    ...(session.worldId ? { worldId: session.worldId } : {}),
    status: session.status,
    completedPlayerTurns: session.completedPlayerTurns,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function registerMediaLibraryRoutes(routes: Hono): void {
  routes.get("/library", async (c) => {
    if (!isMediaLibraryAvailable(c)) return unavailable(c);
    const mediaStore = c.get("mediaStore");
    if (!mediaStore) return unavailable(c);

    const kind = c.req.query("kind");
    if (kind !== undefined && !MEDIA_KINDS.includes(kind as MediaKind)) {
      return invalid(c, `kind must be one of ${MEDIA_KINDS.join(", ")}`);
    }
    const usage = c.req.query("usage");
    if (usage !== undefined && usage !== "unused" && usage !== "in-use") {
      return invalid(c, "usage must be unused or in-use");
    }
    const limit = parsePositiveInteger(c.req.query("limit"));
    const offsetRaw = c.req.query("offset");
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    const scanLimit = parsePositiveInteger(c.req.query("scanLimit"));
    if (
      limit === null ||
      scanLimit === null ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return invalid(
        c,
        "limit and scanLimit must be positive integers, offset a non-negative integer",
      );
    }

    let snapshot: LibrarySnapshot;
    let urlFor: (id: string) => string;
    try {
      snapshot = await librarySnapshot(
        c.get("store"),
        mediaStore,
        scanLimit ?? LIBRARY_SCAN_LIMIT_PER_SESSION,
        c.req.query("refresh") === "1",
      );
      const now = Date.now();
      urlFor = (id) =>
        `/api/media/${encodeURIComponent(id)}?token=${encodeURIComponent(
          signMediaTokenForSession(
            id,
            MEDIA_LIBRARY_TOKEN_SCOPE,
            LIBRARY_TOKEN_TTL_MS,
            now,
          ),
        )}`;
    } catch (error) {
      console.error("[media-library] listing failed:", error);
      return c.json(
        errorBody("media library listing failed", { code: "internal" }),
        500,
      );
    }

    const matching = snapshot.entries.filter(
      (entry) =>
        (kind === undefined || entry.kind === kind) &&
        (usage === undefined ||
          (usage === "unused") === (entry.usage === "unused")),
    );
    const pageSize = Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = matching.slice(offset, offset + pageSize);
    const sessionIds = new Set(page.flatMap((entry) => entry.usedBy));

    return c.json({
      items: page.map((entry) => ({ ...entry, url: urlFor(entry.id) })),
      total: matching.length,
      offset,
      limit: pageSize,
      // Only the sessions named on this page.
      sessions: [...sessionIds].flatMap((id) => {
        const session = snapshot.sessions.get(id);
        return session ? [sessionSummary(session)] : [];
      }),
      totals: snapshot.totals,
      scan: {
        complete: snapshot.complete,
        scannedAt: snapshot.scannedAt,
        ...(snapshot.incompleteSessionId
          ? { incompleteSessionId: snapshot.incompleteSessionId }
          : {}),
      },
    });
  });

  routes.post("/library/delete", async (c) => {
    if (!isMediaLibraryAvailable(c)) return unavailable(c);
    const mediaStore = c.get("mediaStore");
    if (!mediaStore) return unavailable(c);

    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return invalid(c, "request body must be a JSON object");
    }
    const {
      ids,
      unused,
      force,
      scanLimit: rawScanLimit,
    } = body as Record<string, unknown>;
    const scanLimit = parsePositiveInteger(rawScanLimit);
    if (scanLimit === null || typeof scanLimit === "string") {
      return invalid(c, "scanLimit must be a positive integer");
    }
    if (
      (unused !== undefined && unused !== true) ||
      (force !== undefined && typeof force !== "boolean")
    ) {
      return invalid(c, "unused must be true when present, force a boolean");
    }
    const requested =
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= MAX_DELETE_IDS &&
      ids.every((id): id is string => typeof id === "string" && id.length > 0)
        ? [...new Set(ids)]
        : undefined;
    if ((requested === undefined) === (unused !== true)) {
      return invalid(
        c,
        `send either ids (1 to ${MAX_DELETE_IDS} media IDs) or unused: true`,
      );
    }

    try {
      if (force === true) {
        // Taking media away from a session is a decision about one asset.
        const id = requested?.length === 1 ? requested[0] : undefined;
        if (!id) return invalid(c, "force deletes exactly one media ID");
        const asset = await mediaStore.lookup(id);
        if (!asset) {
          return c.json({
            deletedIds: [],
            bytesDeleted: 0,
            skipped: [{ id, reason: "not_found" }],
          });
        }
        await mediaStore.delete(id);
        snapshots.delete(mediaStore);
        return c.json({
          deletedIds: [id],
          bytesDeleted: asset.size,
          skipped: [],
        });
      }

      const scan = await scanMediaReferences(c.get("store"), mediaStore, {
        maxScanRowsPerSession: scanLimit ?? LIBRARY_SCAN_LIMIT_PER_SESSION,
      });
      if (scan.limitExceeded) {
        return c.json(
          errorBody(
            `could not read every row of session ${scan.limitExceededSessionId ?? "<unknown>"}; ` +
              "nothing was deleted because its media cannot be told apart from unused media",
            { code: "scan_incomplete" },
          ),
          409,
        );
      }

      const stored = new Set(scan.assets.map((asset) => asset.id));
      const skipped: { id: string; reason: string }[] = [];
      const candidates = new Set<string>();
      for (const id of requested ?? stored) {
        const usage = stored.has(id) ? usageOf(scan, id) : "not_found";
        if (usage === "unused") candidates.add(id);
        else if (requested) {
          skipped.push({ id, reason: usage === "used" ? "in_use" : usage });
        }
      }

      let deletedIds: readonly string[] = [];
      let bytesDeleted = 0;
      if (candidates.size > 0) {
        // Only the candidates can go, so an asset stored after the scan is
        // kept. The store checks each candidate's owner and references
        // again in the same critical section as its deletion.
        const result = await mediaStore.cleanup(new Set(scan.usedBy.keys()), {
          dryRun: false,
          maxBytes: 0,
          onlyIds: [...candidates],
        });
        deletedIds = result.deletedIds;
        bytesDeleted = result.bytesDeleted;
        const deleted = new Set(deletedIds);
        for (const id of candidates) {
          // Claimed by a session after the scan.
          if (!deleted.has(id)) skipped.push({ id, reason: "in_use" });
        }
      }
      snapshots.delete(mediaStore);
      return c.json({ deletedIds, bytesDeleted, skipped });
    } catch (error) {
      console.error("[media-library] delete failed:", error);
      return c.json(
        errorBody("media library delete failed", { code: "internal" }),
        500,
      );
    }
  });
}
