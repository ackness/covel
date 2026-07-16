/**
 * API AI routes — LLM-driven generation endpoints.
 *
 * POST /ai/generate-world — Generate a world package from a one-line concept.
 * Streams Server-Sent Events so the UI can show phase progress
 * (generating → validating → saving) and receive the final WorldRecord.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createWorld } from "@covel/create";
import { readRuntimeEnv } from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { DataStore, WorldRecord } from "@covel/store";
import { rateLimiter, singleFlight } from "../../middleware/rate-limit.js";
import { loadSingleWorld } from "../../world-seed-loader.js";
import { errorBody } from "../../api-error.js";
import { checkHostedOperator } from "./session/session-guard.js";

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
  return {
    ...record,
    metadata: {
      ...metadata,
      source: saveTarget === "server-store" ? "server-store" : "generated",
    },
  } satisfies WorldRecord;
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
    const body = await c.req.json<Record<string, unknown>>();

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
          locale: typeof body.locale === "string" ? body.locale : "zh-CN",
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
        const fileRecord = await loadSingleWorld(worldDir, {
          source: saveTarget === "server-file" ? "generated-file" : "generated",
          storage: storageMetadata(saveTarget, env.storeBackend, worldsDir),
        });

        if (!fileRecord) {
          await send({
            type: "error",
            message: `Generated world "${result.id}" failed post-write validation`,
          });
          return;
        }

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
