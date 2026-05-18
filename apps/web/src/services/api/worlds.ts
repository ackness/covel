import { parseJsonSseData, readSseStream } from "../sse.js";
import { buildAiHeaders } from "./model-settings.js";
import { request } from "./request.js";
import type {
  GeneratedWorldSaveTarget,
  WorldDataPreflightResponse,
  WorldRecord,
} from "./types.js";

// -- World API ------------------------------------------------------

/** Map server WorldRecord (metadata.dimensions) to frontend WorldRecord (top-level dimensions). */
function mapWorldRecord(w: Record<string, unknown>): WorldRecord {
  const meta = w.metadata as Record<string, unknown> | undefined;
  return {
    ...w,
    dimensions: (w.dimensions ?? meta?.dimensions) as WorldRecord["dimensions"],
  } as WorldRecord;
}

export async function listWorlds(): Promise<WorldRecord[]> {
  const res = await request<{ items: Record<string, unknown>[] }>(
    "/api/worlds",
  );
  return res.items.map(mapWorldRecord);
}

export async function getWorld(id: string): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(id)}`,
  );
  return mapWorldRecord(raw);
}

export async function createWorld(
  name: string,
  description: string,
  id?: string,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>("/api/worlds", {
    method: "POST",
    body: JSON.stringify({ id, name, description }),
  });
  return mapWorldRecord(raw);
}

export async function updateWorld(
  id: string,
  patch: Partial<
    Pick<
      WorldRecord,
      "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
    >
  >,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return mapWorldRecord(raw);
}

export async function deleteWorld(id: string): Promise<void> {
  await request<unknown>(`/api/worlds/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function preflightWorldData(
  worldId: string,
  body: { plugins?: string[]; sessionId?: string },
): Promise<WorldDataPreflightResponse> {
  return request<WorldDataPreflightResponse>(
    `/api/worlds/${encodeURIComponent(worldId)}/world-data/preflight`,
    {
      method: "POST",
      body: JSON.stringify(body),
      silentErrors: true,
    },
  );
}

// -- Dimension Import/Export ------------------------------------------

/** Export world dimensions as a downloadable YAML file. */
export function exportDimensionsUrl(
  worldId: string,
  format: "yaml" | "json" = "yaml",
): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/dimensions/export?format=${format}`;
}

/** Import dimensions into a world (full replace). */
export async function importDimensions(
  worldId: string,
  dimensions: Record<string, unknown>,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(worldId)}/dimensions/import`,
    {
      method: "POST",
      body: JSON.stringify({ dimensions }),
    },
  );
  return mapWorldRecord(raw);
}

/** Re-sync world dimensions into an active session's plugin_data. */
export async function syncSessionDimensions(
  worldId: string,
  sessionId: string,
): Promise<{ success: boolean; syncedKeys: string[]; entryCount: number }> {
  return request(`/api/worlds/${encodeURIComponent(worldId)}/sync-dimensions`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// -- AI World Generation -------------------------------------------

export interface GenerateWorldProgress {
  type: "progress";
  phase: "generating" | "validating" | "saving";
}

export interface GenerateWorldDone {
  type: "done";
  world: WorldRecord;
}

export interface GenerateWorldError {
  type: "error";
  message: string;
}

export type GenerateWorldEvent =
  | GenerateWorldProgress
  | GenerateWorldDone
  | GenerateWorldError;

/**
 * Generate a world via AI from a text prompt.
 * Returns an AbortController to cancel the stream.
 */
export function generateWorld(
  prompt: string,
  locale: string,
  onEvent: (event: GenerateWorldEvent) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
  options?: { saveTarget?: GeneratedWorldSaveTarget },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/ai/generate-world", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
        },
        body: JSON.stringify({
          prompt,
          locale,
          saveTarget: options?.saveTarget,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text}`);
      }

      await readSseStream({
        response: res,
        signal: controller.signal,
        parse: parseJsonSseData<GenerateWorldEvent>,
        onMessage: onEvent,
      });

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}
