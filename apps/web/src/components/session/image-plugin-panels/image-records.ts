import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import type { PluginJobRecord } from "@/stores/plugin-data-store.js";

export interface ImageRecord {
  readonly imageId: string;
  readonly status?: string;
  readonly ref?: MediaRef;
  readonly prompt?: string;
  readonly composition?: string;
  readonly promptMode?: string;
  readonly model?: string;
  readonly imageSize?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface ImageRow {
  readonly key: string;
  readonly value: ImageRecord;
}

export interface ImagePromptPayload {
  readonly prompt: string;
  readonly promptMode?: string;
  readonly composition?: string;
}

export function isImageRecord(
  key: string,
  value: unknown,
): value is ImageRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.imageId === "string" ||
    isMediaRef(rec.ref) ||
    key.startsWith("img-")
  );
}

export function parseImageRows(data: Record<string, unknown>): ImageRow[] {
  const rows: ImageRow[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isImageRecord(key, value)) {
      rows.push({ key, value });
    }
  }
  rows.sort((a, b) =>
    (b.value.startedAt ?? "").localeCompare(a.value.startedAt ?? ""),
  );
  return rows;
}

export function getImageRef(record: ImageRecord): MediaRef | null {
  return isMediaRef(record.ref) ? record.ref : null;
}

export interface JobPromptContext extends ImagePromptPayload {
  readonly prompt: string;
}

export function getJobPromptContext(job: PluginJobRecord): JobPromptContext {
  const output = job.runtimeResults?.[0]?.output as
    | Record<string, unknown>
    | undefined;
  const triggerData = (
    job as unknown as {
      triggerEvent?: {
        data?: {
          prompt?: string;
          promptMode?: string;
          composition?: string;
        };
      };
    }
  ).triggerEvent?.data;
  return {
    prompt:
      triggerData?.prompt ??
      (typeof output?.prompt === "string" ? output.prompt : ""),
    promptMode:
      triggerData?.promptMode ??
      (typeof output?.promptMode === "string" ? output.promptMode : "text"),
    composition:
      triggerData?.composition ??
      (typeof output?.composition === "string"
        ? output.composition
        : "single-scene"),
  };
}

export function findImagesByPrompt(
  images: readonly ImageRow[],
  prompt: string,
): ImageRow[] {
  if (!prompt) return [];
  return images.filter((img) => img.value.prompt === prompt);
}
