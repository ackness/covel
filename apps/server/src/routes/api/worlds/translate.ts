/**
 * World translation route.
 *
 *   POST /worlds/:id/translate — add an edition of a world in another
 *   language, written by the configured model. Streams Server-Sent Events.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { canonicalizeLocale, isKnownLocale } from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { WorldRecord } from "@covel/store";
import { errorBody, readJsonBody } from "../../../api-error.js";
import { streamOwnedSSE } from "../../../application-work.js";
import { orderedSend } from "../../../lib/ordered-send.js";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { rateLimiter, singleFlight } from "../../../middleware/rate-limit.js";
import { parseIdleTimeoutMs } from "../../../world-data/authoring-timeout.js";
import { resolveWorldRoot } from "../../../world-data/session-import/utils.js";
import {
  declareWorldEdition,
  translateWorldPackage,
  untranslatedWorldTexts,
  type TranslateWorldStep,
} from "../../../world-data/translate-world.js";
import {
  isWorldDeleting,
  worldOperationLockId,
} from "../../../world-lifecycle.js";
import { loadSingleWorld } from "../../../world-seed-loader.js";
import { checkHostedOperator } from "../session/session-guard.js";
import type { WorldEnv } from "./shared.js";
import { checkWorldWriteAccess } from "./world-write-guard.js";

type TranslateEvent =
  | {
      type: "progress";
      step: TranslateWorldStep;
      done: number;
      total: number;
    }
  | {
      type: "done";
      world: WorldRecord;
      /** Texts that lacked a translation, and how many now have one. */
      total: number;
      translated: number;
      failed: number;
    }
  | { type: "error"; message: string };

export const worldTranslateRoutes = new Hono<WorldEnv>();

/** Whether `child` is `parent` or a path inside it. */
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// POST /worlds/:id/translate
worldTranslateRoutes.post(
  "/:id/translate",
  async (c, next) => {
    const denied = checkHostedOperator(c) ?? checkWorldWriteAccess(c);
    if (denied) return denied;
    await next();
  },
  rateLimiter({ max: 10 }),
  singleFlight(),
  async (c) => {
    const store = c.get("store");
    const worldId = c.req.param("id");
    const parsed = await readJsonBody<Record<string, unknown>>(c);
    if (parsed instanceof Response) return parsed;
    const locale =
      typeof parsed.body.locale === "string"
        ? canonicalizeLocale(parsed.body.locale)
        : undefined;
    if (!locale || !isKnownLocale(locale)) {
      return c.json(errorBody("locale must be a language tag"), 400);
    }
    const idleTimeout = parseIdleTimeoutMs(parsed.body.idleTimeoutMs);
    if (idleTimeout.error) {
      return c.json(errorBody(idleTimeout.error), 400);
    }

    const world = await store.getWorld(worldId);
    if (!world) {
      return c.json(
        errorBody("World not found", { code: "world_not_found" }),
        404,
      );
    }
    if (isWorldDeleting(world)) {
      return c.json(
        errorBody("World deletion is in progress", { code: "world_deleting" }),
        409,
      );
    }
    // A translation is files beside the world's own. Only a package in the
    // user's world directory is written to: a bundled world ships its
    // editions, and a world in a store or a browser has no files.
    // Compared by real path: a temporary or home directory is often a link.
    const real = (target: string) => realpath(target).catch(() => target);
    const userWorlds = await real(resolveUserResourceDirs().worlds);
    const worldDir = await resolveWorldRoot(worldId, c.get("worldsDirs") ?? []);
    if (!worldDir || !inside(userWorlds, await real(worldDir))) {
      return c.json(
        errorBody(
          "Only a world package in the user world directory can be translated here",
          { code: "world_not_translatable" },
        ),
        409,
      );
    }
    if ((await untranslatedWorldTexts(worldDir, locale)).units.length === 0) {
      return c.json(
        errorBody("The world already has this language", {
          code: "world_already_translated",
        }),
        409,
      );
    }

    const llm = c.get("llmAdapter") as LLMAdapter;
    const shutdownSignal = c.get("requestWork")?.signal;
    return streamOwnedSSE(c, async (stream) => {
      const send = async (event: TranslateEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      try {
        const signal = shutdownSignal
          ? AbortSignal.any([c.req.raw.signal, shutdownSignal])
          : c.req.raw.signal;
        // Progress is sent in order; a write that fails ends the stream.
        const progress = orderedSend(send);
        const result = await translateWorldPackage({
          worldDir,
          locale,
          llm,
          ...(typeof parsed.body.model === "string"
            ? { model: parsed.body.model }
            : {}),
          signal,
          idleTimeoutMs: idleTimeout.value,
          onProgress: (step, done, total) =>
            progress.push({ type: "progress", step, done, total }),
        });
        await progress.settled();
        signal.throwIfAborted();
        if (result.translated === 0) {
          await send({
            type: "error",
            message:
              result.failed[0]?.reason ?? "The model returned no translation",
          });
          return;
        }

        const record = await c
          .get("sessionLock")
          .withLock(worldOperationLockId(worldId), async () => {
            await declareWorldEdition(worldDir, locale);
            const loaded = await loadSingleWorld(worldDir, {
              ...(typeof world.metadata?.source === "string"
                ? { source: world.metadata.source }
                : {}),
              ...(world.metadata?.storage &&
              typeof world.metadata.storage === "object"
                ? {
                    storage: world.metadata.storage as Record<string, unknown>,
                  }
                : {}),
            });
            if (!loaded)
              throw new Error(
                `World "${worldId}" failed validation after translation`,
              );
            const next: WorldRecord = { ...loaded, createdAt: world.createdAt };
            await store.upsertWorld(next);
            // The record as the store gives it, in the shape of `GET /worlds/:id`.
            return (await store.getWorld(worldId)) ?? next;
          });
        console.log(
          `[worlds/translate] ${worldId} → ${locale}: ${result.translated}/${result.total} text(s), ${result.failed.length} failed`,
        );
        await send({
          type: "done",
          world: record,
          total: result.total,
          translated: result.translated,
          failed: result.failed.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[worlds/translate] unexpected error:", message);
        await send({ type: "error", message });
      }
    });
  },
);
