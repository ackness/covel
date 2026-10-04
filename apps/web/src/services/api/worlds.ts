import { parseJsonSseData, readSseStream } from "../sse.js";
import {
  worldCreateRequestSchema,
  worldPatchRequestSchema,
  worldPluginPlanSchema,
  worldWireRecordSchema,
  type WorldCreationBrief,
  type WorldCreateRequest,
  type WorldPatchRequest,
  type WorldPluginPlan,
  type WorldWireRecord,
} from "@covel/shared";
import { request, requestResponse } from "./request.js";
import { pruneMissingSessionCredentials } from "./session-credential-cleanup.js";
import { ignoreError } from "../../lib/ignore-error.js";
import type {
  GeneratedWorldSaveTarget,
  WorldDataPreflightResponse,
  WorldRecord,
} from "./types.js";

// -- World API ------------------------------------------------------

/** Map the shared wire contract into the frontend's local-domain shape. */
function mapWorldRecord(value: unknown): WorldRecord {
  const w = worldWireRecordSchema.parse(value) as WorldWireRecord;
  const meta = w.metadata;
  return {
    ...w,
    dimensions: (w.dimensions ?? meta?.dimensions) as WorldRecord["dimensions"],
    metadata: meta ? { ...meta } : undefined,
    tags: w.tags ? [...w.tags] : undefined,
  };
}

export async function listWorlds(): Promise<WorldRecord[]> {
  const res = await request<{ items: unknown[] }>("/api/worlds");
  return res.items.map(mapWorldRecord);
}

export async function getWorld(
  id: string,
  options?: { silentErrors?: boolean },
): Promise<WorldRecord> {
  const raw = await request<unknown>(
    `/api/worlds/${encodeURIComponent(id)}`,
    options,
  );
  return mapWorldRecord(raw);
}

export async function getWorldPluginPlan(
  worldId: string,
  options?: { silentErrors?: boolean },
): Promise<WorldPluginPlan> {
  return request(`/api/worlds/${encodeURIComponent(worldId)}/plugin-plan`, {
    ...options,
    schema: worldPluginPlanSchema,
  });
}

export async function createWorld(
  input: WorldCreateRequest,
): Promise<WorldRecord> {
  const body = worldCreateRequestSchema.parse(input);
  const raw = await request<unknown>("/api/worlds", {
    method: "POST",
    body: JSON.stringify(body),
    operatorAuth: true,
  });
  return mapWorldRecord(raw);
}

export async function updateWorld(
  id: string,
  patch: WorldPatchRequest,
  options?: { silentStatuses?: readonly number[] },
): Promise<WorldRecord> {
  const body = worldPatchRequestSchema.parse(patch);
  const raw = await request<unknown>(`/api/worlds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    operatorAuth: true,
    silentStatuses: options?.silentStatuses,
  });
  return mapWorldRecord(raw);
}

export async function deleteWorld(id: string): Promise<void> {
  try {
    await request<unknown>(`/api/worlds/${encodeURIComponent(id)}`, {
      method: "DELETE",
      operatorAuth: true,
    });
  } finally {
    await pruneMissingSessionCredentials().catch(
      ignoreError("clean session credentials after world deletion"),
    );
  }
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
      sessionId: body.sessionId,
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
  const raw = await request<unknown>(
    `/api/worlds/${encodeURIComponent(worldId)}/dimensions/import`,
    {
      method: "POST",
      body: JSON.stringify({ dimensions }),
      operatorAuth: true,
    },
  );
  return mapWorldRecord(raw);
}

// -- AI World Generation -------------------------------------------

export interface GenerateWorldProgress {
  type: "progress";
  phase: "generating" | "validating" | "saving";
}

export interface GenerateWorldDone {
  type: "done";
  world: WorldRecord;
  /** How the world falls short of the brief; absent when it does not. */
  warnings?: readonly string[];
}

export interface GenerateWorldError {
  type: "error";
  message: string;
}

/** Plugin-owned content the world generator can produce for the loaded plugins. */
export interface GeneratableWorldContent {
  readonly contract: string;
  readonly title: string;
  readonly description?: string;
  readonly selectedByDefault: boolean;
}

/**
 * List the plugin content a generated world may include. The list comes from
 * the plugins' own authoring declarations, so it changes with the plugins
 * that are installed.
 */
export async function listGeneratableWorldContent(
  locale: string,
): Promise<GeneratableWorldContent[]> {
  const surface = await request<{ contracts?: unknown }>(
    `/api/framework/authoring?locale=${encodeURIComponent(locale)}`,
    { silentErrors: true },
  );
  if (!Array.isArray(surface.contracts)) return [];
  const result: GeneratableWorldContent[] = [];
  for (const item of surface.contracts as Record<string, unknown>[]) {
    if (
      !item ||
      typeof item.contract !== "string" ||
      typeof item.title !== "string" ||
      (item.generate !== "offer" && item.generate !== "default") ||
      result.some((known) => known.contract === item.contract)
    )
      continue;
    result.push({
      contract: item.contract,
      title: item.title,
      // `summary` is written for players and localized; the namespace's
      // technical description is not shown here.
      ...(typeof item.summary === "string"
        ? { description: item.summary }
        : {}),
      selectedByDefault: item.generate === "default",
    });
  }
  return result;
}

export type GenerateWorldEvent =
  GenerateWorldProgress | GenerateWorldDone | GenerateWorldError;

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
  options?: {
    saveTarget?: GeneratedWorldSaveTarget;
    brief?: WorldCreationBrief;
  },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await requestResponse("/api/ai/generate-world", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          locale,
          saveTarget: options?.saveTarget,
          brief: options?.brief,
        }),
        signal: controller.signal,
        operatorAuth: true,
      });

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

/**
 * Change a world that was created in the app, by a request in the player's
 * words. The server streams the same events as `generateWorld`.
 *
 * `world` is the record of a world that only this browser holds: the server
 * revises it and stores nothing.
 */
export function reviseWorld(
  worldId: string,
  instruction: string,
  onEvent: (event: GenerateWorldEvent) => void,
  onError?: (err: Error) => void,
  options?: { world?: WorldRecord },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await requestResponse("/api/ai/revise-world", {
        method: "POST",
        body: JSON.stringify({
          worldId,
          instruction,
          ...(options?.world ? { world: options.world } : {}),
        }),
        signal: controller.signal,
        operatorAuth: true,
      });
      await readSseStream({
        response: res,
        signal: controller.signal,
        parse: parseJsonSseData<GenerateWorldEvent>,
        onMessage: onEvent,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

export type TranslateWorldEvent =
  | {
      type: "progress";
      step: "glossary" | "names" | "texts" | "long texts";
      done: number;
      total: number;
    }
  | {
      type: "done";
      world: WorldRecord;
      total: number;
      translated: number;
      failed: number;
    }
  | { type: "error"; message: string };

/**
 * Add an edition of a world in `locale`, written by the configured model.
 * The server writes locale files beside the world's own and streams progress.
 */
export function translateWorld(
  worldId: string,
  locale: string,
  onEvent: (event: TranslateWorldEvent) => void,
  onError?: (err: Error) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await requestResponse(
        `/api/worlds/${encodeURIComponent(worldId)}/translate`,
        {
          method: "POST",
          body: JSON.stringify({ locale }),
          signal: controller.signal,
          operatorAuth: true,
        },
      );
      await readSseStream({
        response: res,
        signal: controller.signal,
        parse: parseJsonSseData<TranslateWorldEvent>,
        onMessage: onEvent,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}
