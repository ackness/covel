import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaStore } from "@covel/store";
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

function mediaIdForBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function maybeDeleteOwnedUnreferencedMedia(options: {
  mediaStore: MediaStore;
  mediaId: string;
  sessionId: string;
}): Promise<void> {
  const lookup = await options.mediaStore.lookup(options.mediaId);
  if (lookup?.ownerSessionId !== options.sessionId) return;
  const refs = (await options.mediaStore.listRefs()).filter(
    (ref) => ref.mediaId === options.mediaId,
  );
  if (refs.length > 0) return;
  await options.mediaStore.delete(options.mediaId, { force: true });
}

export async function materializeMediaIndexWrites(options: {
  mediaStore?: MediaStore;
  sessionId: string;
  writes: readonly PlannedWrite[];
  /**
   * Called immediately after each successful `put`, before the next file is
   * read. The caller records these so a mid-loop failure can still compensate
   * for what already landed: this function only RETURNS its refs on success,
   * so a throw on the second file used to leave the first asset orphaned in
   * the MediaStore with nothing referencing it.
   */
  onMediaRef?: (ref: WorldDataImportedMediaRef) => void;
}): Promise<{
  readonly writes: readonly PlannedWrite[];
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}> {
  const out: PlannedWrite[] = [];
  const mediaRefs: WorldDataImportedMediaRef[] = [];
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
    const mediaId = mediaIdForBytes(bytes);
    const existing = await options.mediaStore.lookup(mediaId);
    const existingRefs = existing
      ? (await options.mediaStore.listRefs()).filter(
          (ref) => ref.mediaId === mediaId,
        )
      : [];
    const cleanupOnFailure =
      !existing ||
      (existing.ownerSessionId === null && existingRefs.length === 0);
    const ref = await options.mediaStore.put(bytes, mediaMime(mediaPath), {
      filename: path.basename(mediaPath),
      sourceId: write.source.id,
    });
    const importedRef = {
      id: ref.id,
      sessionId: options.sessionId,
      pluginId: write.pluginId,
      cleanupOnFailure,
    };
    mediaRefs.push(importedRef);
    // Register with the caller's compensation stack before touching the next
    // file, so a later throw can still roll this one back.
    options.onMediaRef?.(importedRef);
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
}

export async function finalizeWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  for (const ref of options.refs) {
    await options.mediaStore.recordOwnership(
      ref.id,
      ref.sessionId,
      ref.pluginId,
    );
    await options.mediaStore.addRef(ref.id, ref.sessionId, ref.pluginId);
  }
}

export async function cleanupWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  for (const ref of [...options.refs].reverse()) {
    if (!ref.cleanupOnFailure) continue;
    try {
      await options.mediaStore.delete(ref.id, { force: true });
    } catch {
      // Preserve the import/finalize failure as the caller-visible error.
    }
  }
}
