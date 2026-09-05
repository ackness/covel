/**
 * API AI routes — LLM-driven generation endpoints.
 *
 * POST /ai/generate-world — Generate a world package from a creative brief.
 * Streams Server-Sent Events so the UI can show phase progress
 * (generating → validating → saving) and receive the final WorldRecord.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createWorld, type GeneratedWorldPackageContent } from "@covel/create";
import {
  DEFAULT_LOCALE,
  readRuntimeEnv,
  WORLD_EXPERIENCE_MODES,
  WORLD_PACKAGE_CONTENT_KINDS,
  type WorldCreationBrief,
} from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { DataStore, WorldRecord } from "@covel/store";
import { rateLimiter, singleFlight } from "../../middleware/rate-limit.js";
import { loadSingleWorld } from "../../world-seed-loader.js";
import { errorBody, readJsonBody } from "../../api-error.js";
import { checkHostedOperator } from "./session/session-guard.js";
import { checkWorldWriteAccess } from "./worlds/world-write-guard.js";
import { normalizeLocale } from "../../lib/validators.js";

type Env = {
  Variables: {
    llmAdapter: LLMAdapter;
    store: DataStore;
  };
};

export const aiRoutes = new Hono<Env>();

interface ProgressEvent {
  type: "progress";
  phase: "generating" | "validating" | "saving";
}
interface DoneEvent {
  type: "done";
  world: unknown;
}
interface ErrorEvent {
  type: "error";
  message: string;
}
type GenerateEvent = ProgressEvent | DoneEvent | ErrorEvent;

const GENERATE_WORLD_ATTEMPT_TIMEOUT_MS = 150_000;
type SaveTarget = "server-file" | "server-store" | "return-only";

function resolveSaveTarget(value: unknown): SaveTarget | null {
  if (value === undefined) return "server-file";
  return value === "server-file" ||
    value === "server-store" ||
    value === "return-only"
    ? value
    : null;
}

function storageMetadata(
  saveTarget: SaveTarget,
  backend: ReturnType<typeof readRuntimeEnv>["storeBackend"],
  worldsDir: string,
): Record<string, unknown> {
  if (saveTarget === "server-file") {
    return {
      scope: "server",
      backend: "file",
      path: worldsDir,
      durable: true,
    };
  }
  if (saveTarget === "server-store") {
    return {
      scope: "server",
      backend,
      durable: backend !== "memory",
    };
  }
  return {
    scope: "transient",
    backend: "response",
    durable: false,
  };
}

function recordForStoreOnly(record: WorldRecord, saveTarget: SaveTarget) {
  const metadata = { ...record.metadata };
  delete metadata.source;
  delete metadata.dimensionSources;
  delete metadata.worldDataPath;
  delete metadata.worldData;
  delete metadata.characterBlueprintSources;
  return {
    ...record,
    metadata: {
      ...metadata,
      source: saveTarget === "server-store" ? "server-store" : "generated",
    },
  } satisfies WorldRecord;
}

function parseCreationBrief(value: unknown): {
  value?: WorldCreationBrief;
  error?: string;
} {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "brief must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const experienceMode = raw.experienceMode;
  if (
    experienceMode !== undefined &&
    (typeof experienceMode !== "string" ||
      !WORLD_EXPERIENCE_MODES.includes(
        experienceMode as (typeof WORLD_EXPERIENCE_MODES)[number],
      ))
  ) {
    return {
      error: `brief.experienceMode must be one of ${WORLD_EXPERIENCE_MODES.join(", ")}`,
    };
  }
  const content = raw.content;
  if (
    content !== undefined &&
    (!Array.isArray(content) ||
      content.some(
        (item) =>
          typeof item !== "string" ||
          !WORLD_PACKAGE_CONTENT_KINDS.includes(
            item as (typeof WORLD_PACKAGE_CONTENT_KINDS)[number],
          ),
      ))
  ) {
    return {
      error: `brief.content entries must be one of ${WORLD_PACKAGE_CONTENT_KINDS.join(", ")}`,
    };
  }
  const additionalInstructions = raw.additionalInstructions;
  if (
    additionalInstructions !== undefined &&
    typeof additionalInstructions !== "string"
  ) {
    return { error: "brief.additionalInstructions must be a string" };
  }
  if (
    typeof additionalInstructions === "string" &&
    additionalInstructions.length > 2000
  ) {
    return {
      error: "brief.additionalInstructions must be 2000 characters or fewer",
    };
  }
  return {
    value: {
      ...(typeof experienceMode === "string" ? { experienceMode } : {}),
      ...(Array.isArray(content)
        ? { content: [...new Set(content as string[])] }
        : {}),
      ...(typeof additionalInstructions === "string"
        ? { additionalInstructions: additionalInstructions.trim() }
        : {}),
    } as WorldCreationBrief,
  };
}

function withGeneratedPackageMetadata(
  record: WorldRecord,
  packageContent: GeneratedWorldPackageContent | undefined,
): WorldRecord {
  if (!packageContent) return record;
  const embeddedLorebook = [
    ...packageContent.lorebook,
    ...packageContent.rules,
  ];
  return {
    ...record,
    metadata: {
      ...record.metadata,
      ...(packageContent.characters.length > 0
        ? { characterBlueprints: packageContent.characters }
        : {}),
      ...(embeddedLorebook.length > 0 ? { embeddedLorebook } : {}),
      generatedPackageSummary: {
        characters: packageContent.characters.length,
        lorebook: packageContent.lorebook.length,
        rules: packageContent.rules.length,
      },
    },
  };
}

// POST /ai/generate-world
aiRoutes.post(
  "/generate-world",
  async (c, next) => {
    const denied = checkHostedOperator(c);
    if (denied) return denied;
    await next();
  },
  rateLimiter({ max: 10 }),
  singleFlight(),
  async (c) => {
    const llm = c.get("llmAdapter");
    const store = c.get("store");
    const parsed = await readJsonBody<Record<string, unknown>>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;

    const concept = body.concept ?? body.prompt;
    if (typeof concept !== "string" || !concept.trim()) {
      return c.json(errorBody("concept (string) is required"), 400);
    }
    if (concept.length > 4000) {
      return c.json(errorBody("concept must be 4000 characters or fewer"), 400);
    }
    const saveTarget = resolveSaveTarget(body.saveTarget);
    if (!saveTarget) {
      return c.json(
        errorBody(
          'saveTarget must be "server-file", "server-store", or "return-only"',
        ),
        400,
      );
    }
    if (saveTarget !== "return-only") {
      const denied = checkWorldWriteAccess(c);
      if (denied) return denied;
    }
    const brief = parseCreationBrief(body.brief);
    if (brief.error) {
      return c.json(errorBody(brief.error), 400);
    }

    const env = readRuntimeEnv();
    const worldsDir =
      env.userWorldsDir ??
      env.worldsDir ??
      resolve(import.meta.dirname, "../../../../../worlds");

    const outputDir =
      saveTarget === "server-file"
        ? worldsDir
        : await mkdtemp(path.join(tmpdir(), "covel-ai-world-"));

    console.log(
      `[ai/generate-world] outputDir=${outputDir}, saveTarget=${saveTarget}, concept="${(concept as string).trim().slice(0, 40)}..."`,
    );

    return streamSSE(c, async (stream) => {
      const send = async (event: GenerateEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };

      try {
        await send({ type: "progress", phase: "generating" });

        const createOpts = {
          llm,
          concept: (concept as string).trim(),
          outputDir,
          model: typeof body.model === "string" ? body.model : undefined,
          locale: normalizeLocale(body.locale, DEFAULT_LOCALE),
          brief: brief.value,
          signal: c.req.raw.signal,
          attemptTimeoutMs: GENERATE_WORLD_ATTEMPT_TIMEOUT_MS,
          logger: {
            info: (...args: unknown[]) => console.log("[createWorld]", ...args),
            warn: (...args: unknown[]) =>
              console.warn("[createWorld]", ...args),
            error: (...args: unknown[]) =>
              console.error("[createWorld]", ...args),
          },
        };

        const startMs = Date.now();
        const result = await createWorld(createOpts);
        const elapsedMs = Date.now() - startMs;

        console.log(
          `[ai/generate-world] createWorld finished in ${elapsedMs}ms success=${result.success} id=${result.id}`,
        );

        if (!result.success) {
          console.error(
            `[ai/generate-world] generation failed after ${elapsedMs}ms:`,
            result.errors,
          );
          await send({
            type: "error",
            message: result.errors?.join("\n") ?? "World generation failed",
          });
          return;
        }

        await send({ type: "progress", phase: "validating" });

        // Reload the freshly written world.yaml into a WorldRecord and upsert
        // into the store so the listing endpoint immediately reflects it.
        const worldDir = path.join(outputDir, result.id);
        const loadedRecord = await loadSingleWorld(worldDir, {
          source: saveTarget === "server-file" ? "generated-file" : "generated",
          storage: storageMetadata(saveTarget, env.storeBackend, worldsDir),
        });

        if (!loadedRecord) {
          await send({
            type: "error",
            message: `Generated world "${result.id}" failed post-write validation`,
          });
          return;
        }
        const fileRecord = withGeneratedPackageMetadata(
          loadedRecord,
          result.packageContent,
        );

        await send({ type: "progress", phase: "saving" });
        const record =
          saveTarget === "server-file"
            ? fileRecord
            : recordForStoreOnly(fileRecord, saveTarget);
        if (saveTarget !== "return-only") {
          await store.upsertWorld(record);
        }

        console.log(
          `[ai/generate-world] world generated: id=${record.id} saveTarget=${saveTarget}`,
        );
        await send({ type: "done", world: record });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ai/generate-world] unexpected error:", msg);
        await send({
          type: "error",
          message: msg,
        });
      } finally {
        if (saveTarget !== "server-file") {
          await rm(outputDir, { recursive: true, force: true });
        }
      }
    });
  },
);
