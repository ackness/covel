import { worldGenerationDataContracts } from "../../world-data/portable-contract-data.js";
/**
 * API AI routes — LLM-driven generation endpoints.
 *
 * POST /ai/generate-world — Generate a world package from a creative brief.
 * POST /ai/revise-world — Change a world that was created here, by a request
 * in the player's words.
 * Both stream Server-Sent Events so the UI can show phase progress
 * (generating → validating → saving), the part the model is writing, and
 * receive the final WorldRecord.
 */

import { worldOperationLockId } from "../../world-lifecycle.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { streamOwnedSSE } from "../../application-work.js";
import {
  createWorld,
  writeWorldPackage,
  type GeneratedWorldPackageContent,
} from "@covel/create";
import { worldRecordFromManifest } from "../../world-data/world-record.js";
import {
  DEFAULT_LOCALE,
  readRuntimeEnv,
  WORLD_EXPERIENCE_MODES,
  WORLD_PACKAGE_CONTENT_KINDS,
  type WorldCreationBrief,
  type WorldGenerationPart,
} from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { DataStore, WorldRecord } from "@covel/store";
import { rateLimiter, singleFlight } from "../../middleware/rate-limit.js";
import { loadSingleWorld } from "../../world-seed-loader.js";
import { errorBody, readJsonBody } from "../../api-error.js";
import { checkHostedOperator } from "./session/session-guard.js";
import { checkWorldWriteAccess } from "./worlds/world-write-guard.js";
import { normalizeLocale } from "../../lib/validators.js";
import { resolveUserResourceDirs } from "../../lib/user-resource-dirs.js";
import { isWorldDeleting } from "../../world-lifecycle.js";
import { worldSectionsOf } from "../../world-data/world-sections.js";
import { parseIdleTimeoutMs } from "../../world-data/authoring-timeout.js";

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
  /** While generating: every part of the world and how far each one is. */
  parts?: readonly WorldGenerationPart[];
}
interface DoneEvent {
  type: "done";
  world: unknown;
  /** How the world falls short of the brief; absent when it does not. */
  warnings?: readonly string[];
}
interface ErrorEvent {
  type: "error";
  message: string;
  /** The model stayed silent for the whole idle timeout; a longer one may help. */
  code?: "model_idle_timeout";
}
type GenerateEvent = ProgressEvent | DoneEvent | ErrorEvent;

/**
 * Sends the progress of the parts in the order it was reported. `createWorld`
 * reports synchronously and does not wait for the stream; `settled` resolves
 * when every report is written, and rejects when the client is gone.
 */
function partProgress(send: (event: GenerateEvent) => Promise<void>) {
  let pending = Promise.resolve();
  return {
    report(parts: readonly WorldGenerationPart[]) {
      pending = pending.then(() =>
        send({ type: "progress", phase: "generating", parts }),
      );
      // The failure is seen by `settled`; this keeps it from being unhandled.
      pending.catch(() => undefined);
    },
    settled: () => pending,
  };
}
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

function parseCreationBrief(
  value: unknown,
  availableContracts: readonly string[],
): {
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
  const contracts = raw.contracts;
  if (
    contracts !== undefined &&
    (!Array.isArray(contracts) ||
      contracts.some(
        (item) =>
          typeof item !== "string" || !availableContracts.includes(item),
      ))
  ) {
    return {
      error: availableContracts.length
        ? `brief.contracts entries must be one of ${availableContracts.join(", ")}`
        : "brief.contracts is not supported: no active plugin offers generated content",
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
      ...(Array.isArray(contracts)
        ? { contracts: [...new Set(contracts as string[])] }
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
      ...(packageContent.contractData?.length
        ? { contractData: packageContent.contractData }
        : {}),
      ...(packageContent.characters.length > 0
        ? { characterBlueprints: packageContent.characters }
        : {}),
      ...(embeddedLorebook.length > 0 ? { embeddedLorebook } : {}),
      generatedPackageSummary: {
        characters: packageContent.characters.length,
        lorebook: packageContent.lorebook.length,
        rules: packageContent.rules.length,
      },
      // The generator made this world, so the app may rewrite it. A package
      // on disk carries the same fact as its marker file.
      generated: true,
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
    const dataContracts = await worldGenerationDataContracts(
      c.get("pluginRegistry"),
    );
    const brief = parseCreationBrief(
      body.brief,
      dataContracts.map((item) => item.contract),
    );
    if (brief.error) {
      return c.json(errorBody(brief.error), 400);
    }
    const idleTimeout = parseIdleTimeoutMs(body.idleTimeoutMs);
    if (idleTimeout.error) {
      return c.json(errorBody(idleTimeout.error), 400);
    }

    const env = readRuntimeEnv();
    const worldsDir = resolveUserResourceDirs(env).worlds;

    const shutdownSignal = c.get("requestWork")?.signal;
    return streamOwnedSSE(c, async (stream) => {
      const send = async (event: GenerateEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };

      let generatedWorldDir: string | undefined;
      let activated = false;
      try {
        shutdownSignal?.throwIfAborted();
        await send({ type: "progress", phase: "generating" });

        const progress = partProgress(send);
        const createOpts = {
          llm,
          concept: (concept as string).trim(),
          model: typeof body.model === "string" ? body.model : undefined,
          locale: normalizeLocale(body.locale, DEFAULT_LOCALE),
          brief: brief.value,
          dataContracts,
          signal: shutdownSignal
            ? AbortSignal.any([c.req.raw.signal, shutdownSignal])
            : c.req.raw.signal,
          idleTimeoutMs: idleTimeout.value,
          onProgress: progress.report,
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
        await progress.settled();
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
            ...(result.idleTimeout
              ? { code: "model_idle_timeout" as const }
              : {}),
          });
          return;
        }

        await send({ type: "progress", phase: "validating" });

        let loadedRecord: WorldRecord | null;
        const metadata = {
          source: saveTarget === "server-file" ? "generated-file" : "generated",
          storage: storageMetadata(saveTarget, env.storeBackend, worldsDir),
        };
        if (saveTarget === "server-file") {
          createOpts.signal.throwIfAborted();
          await writeWorldPackage(worldsDir, result);
          generatedWorldDir = path.join(worldsDir, result.id);
          loadedRecord = await loadSingleWorld(generatedWorldDir, metadata);
          if (!loadedRecord)
            throw new Error(
              `Generated world "${result.id}" failed post-write validation`,
            );
        } else {
          loadedRecord = worldRecordFromManifest(result.manifest, result.lore, {
            ...metadata,
            ...(result.packageContent.characters.length
              ? { embeddedCharacters: result.packageContent.characters }
              : {}),
          });
        }
        const generatedRecord = withGeneratedPackageMetadata(
          loadedRecord,
          result.packageContent,
        );

        await send({ type: "progress", phase: "saving" });
        const record =
          saveTarget === "server-file"
            ? generatedRecord
            : recordForStoreOnly(generatedRecord, saveTarget);
        if (saveTarget !== "return-only") {
          shutdownSignal?.throwIfAborted();
          if (
            !(await c
              .get("sessionLock")
              .withLock(worldOperationLockId(record.id), () =>
                store.createWorld(record),
              ))
          ) {
            throw new Error(`World already exists: ${record.id}`);
          }
          activated = true;
        }

        console.log(
          `[ai/generate-world] world generated: id=${record.id} saveTarget=${saveTarget}`,
        );
        if (result.warnings.length > 0)
          console.warn(
            `[ai/generate-world] world ${record.id} generated with warnings:`,
            result.warnings,
          );
        await send({
          type: "done",
          world: record,
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ai/generate-world] unexpected error:", msg);
        await send({
          type: "error",
          message: msg,
        });
      } finally {
        if (saveTarget === "server-file" && generatedWorldDir && !activated) {
          await rm(generatedWorldDir, { recursive: true, force: true });
        }
      }
    });
  },
);

const REVISION_MAX_LENGTH = 2000;

/**
 * Where a world that the app may rewrite lives. Only a world the generator
 * made is rewritten (`metadata.generated`; for a package on disk that is the
 * marker file in it): a package made by hand or installed holds media and
 * sources that a rewrite would lose.
 */
function revisableTarget(record: WorldRecord): SaveTarget | null {
  if (record.metadata?.generated !== true) return null;
  return record.metadata.source === "server-store"
    ? "server-store"
    : "server-file";
}

/** The record a browser sends for a world that only it holds. */
function browserWorld(value: unknown, worldId: string): WorldRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<WorldRecord>;
  return record.id === worldId &&
    record.metadata?.generated === true &&
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    (record.lore === undefined || typeof record.lore === "string") &&
    (record.metadata === undefined ||
      (record.metadata !== null && typeof record.metadata === "object"))
    ? (record as WorldRecord)
    : null;
}

// POST /ai/revise-world
aiRoutes.post(
  "/revise-world",
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

    const worldId = body.worldId;
    if (typeof worldId !== "string" || !worldId.trim()) {
      return c.json(errorBody("worldId (string) is required"), 400);
    }
    const instruction = body.instruction;
    if (typeof instruction !== "string" || !instruction.trim()) {
      return c.json(errorBody("instruction (string) is required"), 400);
    }
    if (instruction.length > REVISION_MAX_LENGTH) {
      return c.json(
        errorBody(
          `instruction must be ${REVISION_MAX_LENGTH} characters or fewer`,
        ),
        400,
      );
    }
    const idleTimeout = parseIdleTimeoutMs(body.idleTimeoutMs);
    if (idleTimeout.error) {
      return c.json(errorBody(idleTimeout.error), 400);
    }

    const stored = await store.getWorld(worldId);
    let existing: WorldRecord;
    let saveTarget: SaveTarget;
    if (stored) {
      const target = revisableTarget(stored);
      if (!target) {
        return c.json(
          errorBody(
            "Only a world created in the app can be revised; edit the files of a world package instead",
            { code: "world_not_revisable" },
          ),
          409,
        );
      }
      if (isWorldDeleting(stored)) {
        return c.json(
          errorBody("World deletion is in progress", {
            code: "world_deleting",
          }),
          409,
        );
      }
      const denied = checkWorldWriteAccess(c);
      if (denied) return denied;
      existing = stored;
      saveTarget = target;
    } else {
      // A world that lives in the browser: the client sends it and keeps the
      // result. Nothing is written on the server.
      const sent = browserWorld(body.world, worldId);
      if (!sent) {
        return c.json(
          errorBody("World not found", { code: "world_not_found" }),
          404,
        );
      }
      existing = sent;
      saveTarget = "return-only";
    }

    const env = readRuntimeEnv();
    const worldsDir = resolveUserResourceDirs(env).worlds;
    const worldDir = path.join(worldsDir, existing.id);
    const dataContracts = await worldGenerationDataContracts(
      c.get("pluginRegistry"),
    );
    const shutdownSignal = c.get("requestWork")?.signal;

    return streamOwnedSSE(c, async (stream) => {
      const send = async (event: GenerateEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      try {
        shutdownSignal?.throwIfAborted();
        await send({ type: "progress", phase: "generating" });
        const signal = shutdownSignal
          ? AbortSignal.any([c.req.raw.signal, shutdownSignal])
          : c.req.raw.signal;
        const progress = partProgress(send);
        const result = await createWorld({
          llm,
          concept: existing.description || existing.name,
          model: typeof body.model === "string" ? body.model : undefined,
          locale: normalizeLocale(existing.locale, DEFAULT_LOCALE),
          dataContracts,
          revision: {
            current: await worldSectionsOf(
              existing,
              saveTarget === "server-file" ? worldDir : undefined,
            ),
            instruction: instruction.trim(),
          },
          signal,
          idleTimeoutMs: idleTimeout.value,
          onProgress: progress.report,
          logger: {
            info: (...args: unknown[]) => console.log("[reviseWorld]", ...args),
            warn: (...args: unknown[]) =>
              console.warn("[reviseWorld]", ...args),
            error: (...args: unknown[]) =>
              console.error("[reviseWorld]", ...args),
          },
        });
        await progress.settled();
        if (!result.success) {
          console.error("[ai/revise-world] revision failed:", result.errors);
          await send({
            type: "error",
            message: result.errors?.join("\n") ?? "World revision failed",
            ...(result.idleTimeout
              ? { code: "model_idle_timeout" as const }
              : {}),
          });
          return;
        }

        await send({ type: "progress", phase: "validating" });
        const metadata = {
          source: saveTarget === "server-file" ? "generated-file" : "generated",
          storage: storageMetadata(saveTarget, env.storeBackend, worldsDir),
        };
        const save = async (): Promise<WorldRecord> => {
          let loaded: WorldRecord | null;
          if (saveTarget === "server-file") {
            signal.throwIfAborted();
            // The old package stays until the new one is in place.
            await writeWorldPackage(worldsDir, result, { replace: true });
            loaded = await loadSingleWorld(worldDir, metadata);
            if (!loaded)
              throw new Error(
                `Revised world "${result.id}" failed post-write validation`,
              );
          } else {
            loaded = worldRecordFromManifest(result.manifest, result.lore, {
              ...metadata,
              ...(result.packageContent.characters.length
                ? { embeddedCharacters: result.packageContent.characters }
                : {}),
            });
          }
          const revised = withGeneratedPackageMetadata(
            loaded,
            result.packageContent,
          );
          const record: WorldRecord = {
            ...(saveTarget === "server-file"
              ? revised
              : recordForStoreOnly(revised, saveTarget)),
            createdAt: existing.createdAt,
          };
          if (saveTarget === "return-only") return record;
          await store.upsertWorld(record);
          // The record as the store gives it, in the shape of `GET /worlds/:id`.
          return (await store.getWorld(record.id)) ?? record;
        };

        await send({ type: "progress", phase: "saving" });
        shutdownSignal?.throwIfAborted();
        const record =
          saveTarget === "return-only"
            ? await save()
            : await c
                .get("sessionLock")
                .withLock(worldOperationLockId(existing.id), save);
        console.log(
          `[ai/revise-world] world revised: id=${record.id} saveTarget=${saveTarget}`,
        );
        await send({
          type: "done",
          world: record,
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ai/revise-world] unexpected error:", msg);
        await send({ type: "error", message: msg });
      }
    });
  },
);
