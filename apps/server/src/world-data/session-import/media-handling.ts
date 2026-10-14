import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MEDIA_PIN_REF_PREFIX } from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";
import { scanSessionMediaIds } from "../../routes/api/media-reference-scan.js";
import type { PlannedWrite, WorldDataImportedMediaRef } from "./types.js";
import { isRecord } from "./utils.js";

export function mediaMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

export async function materializeMediaIndexWrites(options: {
  mediaStore?: MediaStore;
  sessionId: string;
  writes: readonly PlannedWrite[];
}): Promise<{
  readonly writes: readonly PlannedWrite[];
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}> {
  const out: PlannedWrite[] = [];
  const mediaRefs: WorldDataImportedMediaRef[] = [];
  // Each attempt owns only its claims.
  const temporarySessionId = `${MEDIA_PIN_REF_PREFIX}${randomUUID()}`;
  try {
    for (const write of options.writes) {
      if (write.kind !== "media-index") {
        out.push(write);
        continue;
      }
      const importInfo = isRecord(write.value)
        ? (write.value.import as unknown)
        : undefined;
      const mediaPath =
        isRecord(importInfo) && typeof importInfo.path === "string"
          ? importInfo.path
          : undefined;
      if (!mediaPath || !options.mediaStore) {
        out.push(write);
        continue;
      }
      const bytes = await readFile(mediaPath);
      const ref = await options.mediaStore.put(
        bytes,
        mediaMime(mediaPath),
        {
          filename: path.basename(mediaPath),
          sourceId: write.source.id,
        },
        { sessionId: temporarySessionId, pluginId: write.pluginId },
      );
      const importedRef = {
        temporarySessionId,
        id: ref.id,
        sessionId: options.sessionId,
        pluginId: write.pluginId,
      };
      mediaRefs.push(importedRef);
      out.push({
        ...write,
        value: {
          ref,
          filename: path.basename(mediaPath),
          sourceId: write.source.id,
        },
      });
    }
    return { writes: out, mediaRefs };
  } catch (error) {
    await releaseWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
    throw error;
  }
}

/** Release only preparation claims; never another import's or session's refs. */
export async function releaseWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  for (const ref of options.refs) {
    try {
      await options.mediaStore.removeRef(ref.id, ref.temporarySessionId);
    } catch {
      // Retain conservatively without masking the original import outcome.
      console.warn(
        "[world-data] failed to release a temporary media reference",
      );
    }
  }
}

export async function finalizeWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  // One transaction: a failure part-way leaves none of the files claimed.
  await options.mediaStore.claimAssets(
    options.refs.map((ref) => ({
      id: ref.id,
      sessionId: ref.sessionId,
      ...(ref.pluginId === undefined ? {} : { pluginId: ref.pluginId }),
    })),
  );
  await releaseWorldDataMediaRefs(options);
}

/**
 * Most rows a sync reads to decide which dropped media the session still
 * names; the same ceiling as the player's media library.
 */
const UNREF_SCAN_LIMIT_PER_SESSION = 200_000;

/**
 * Withdraw the session's references to media a sync dropped from its world
 * data, except media the session still names anywhere: another index row
 * (identical bytes share one ID), a message, a snapshot, a runtime output, a
 * trace or a turn result. A picture the session has shown stays readable by
 * the session and by its forks. A scan that cannot finish keeps every
 * reference. Ownership and bytes are left to lifecycle cleanup.
 */
export async function releaseUnusedSessionMediaRefs(options: {
  store: DataStore;
  mediaStore: MediaStore;
  sessionId: string;
  mediaIds: readonly string[];
}): Promise<void> {
  let scanned: Awaited<ReturnType<typeof scanSessionMediaIds>>;
  try {
    scanned = await scanSessionMediaIds(
      options.store,
      options.sessionId,
      UNREF_SCAN_LIMIT_PER_SESSION,
    );
  } catch {
    // The sync already committed; keeping a reference is the safe outcome.
    console.warn("[world-data] failed to scan a session's media references");
    return;
  }
  if (!scanned.complete) return;
  for (const mediaId of new Set(options.mediaIds)) {
    if (scanned.ids.has(mediaId)) continue;
    try {
      await options.mediaStore.removeRef(mediaId, options.sessionId);
    } catch {
      // Continue with the remaining references.
    }
  }
}
