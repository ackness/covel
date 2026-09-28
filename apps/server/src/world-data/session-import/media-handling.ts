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
    const ref = await options.mediaStore.put(bytes, mediaMime(mediaPath), {
      filename: path.basename(mediaPath),
      sourceId: write.source.id,
    });
    const importedRef = {
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
