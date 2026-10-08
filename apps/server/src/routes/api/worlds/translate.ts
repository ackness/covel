/**
 * World translation route.
 *
 *   POST /worlds/:id/translate — add an edition of a world in another
 *   language, written by the configured model. Streams Server-Sent Events.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import {
  WORLD_EDITIONS_KEY,
  readRuntimeEnv,
  canonicalizeLocale,
  isKnownLocale,
} from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { WorldRecord } from "@covel/store";
import {
  classifyApiError,
  errorBody,
  logRequestError,
  readJsonBody,
} from "../../../api-error.js";
import { streamOwnedSSE } from "../../../application-work.js";
import { orderedSend } from "../../../lib/ordered-send.js";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { rateLimiter, singleFlight } from "../../../middleware/rate-limit.js";
import { parseIdleTimeoutMs } from "../../../world-data/authoring-timeout.js";
import { writeWorldTranslations } from "../../../world-data/locale-tooling.js";
import { resolveWorldRoot } from "../../../world-data/session-import/utils.js";
import {
  declareWorldEdition,
  prepareWorldTranslation,
  untranslatedWorldTexts,
  type TranslateWorldStep,
} from "../../../world-data/translate-world.js";
import {
  isWorldDeleting,
  worldOperationLockId,
} from "../../../world-lifecycle.js";
import {
  loadSingleWorld,
  preserveWorldProvenance,
} from "../../../world-seed-loader.js";
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

/**
 * The record of a world whose files gained an edition.
 *
 * Whether a record follows its files is the rule of every package reload: a
 * package edited in the app keeps its own content. Such a record takes the
 * new edition and its translated text, so a session may use it; the other
 * fields of the files would bring back the text the edit replaced.
 */
function withNewEdition(
  loaded: WorldRecord,
  current: WorldRecord,
  locale: string,
): WorldRecord {
  const next = preserveWorldProvenance(loaded, current);
  const editions = loaded.metadata?.[WORLD_EDITIONS_KEY];
  const currentTexts = current.metadata?.localizedText as
    Record<string, Record<string, string>> | undefined;
  const loadedTexts = loaded.metadata?.localizedText as
    Record<string, Record<string, string>> | undefined;
  const localizedText = { ...currentTexts };
  for (const field of ["name", "description", "lore"]) {
    const translated = loadedTexts?.[field]?.[locale];
    if (translated !== undefined)
      localizedText[field] = { ...localizedText[field], [locale]: translated };
  }
  return {
    ...next,
    metadata: {
      ...next.metadata,
      localizedText: {
        ...(next.metadata?.localizedText as object),
        ...localizedText,
      },
      ...(editions === undefined ? {} : { [WORLD_EDITIONS_KEY]: editions }),
    },
    updatedAt: loaded.updatedAt,
  };
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
    const packagePath = await realpath(worldDir);
    const packageIdentity = await stat(packagePath);
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
        const result = await prepareWorldTranslation({
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
          // Why a text was refused (a changed placeholder, a reply that is
          // not JSON) is what the player needs to try again.
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
            // Models run without the lock. Only the original record and package
            // may receive their result; an editor patch keeps the same identity.
            const current = await store.getWorld(worldId);
            if (
              !current ||
              isWorldDeleting(current) ||
              current.createdAt !== world.createdAt
            ) {
              return undefined;
            }
            const currentRoot = await resolveWorldRoot(
              worldId,
              c.get("worldsDirs") ?? [],
            );
            const currentPath = currentRoot
              ? await realpath(currentRoot).catch(() => undefined)
              : undefined;
            if (currentPath !== packagePath) return undefined;
            const identity = await stat(currentPath).catch(() => undefined);
            // createdAt can be supplied on creation. A replacement at the same
            // path must still be rejected if it reused that timestamp.
            if (
              !identity ||
              identity.dev !== packageIdentity.dev ||
              identity.ino !== packageIdentity.ino ||
              identity.birthtimeMs !== packageIdentity.birthtimeMs
            )
              return undefined;
            signal.throwIfAborted();
            await writeWorldTranslations(
              packagePath,
              locale,
              result.translations,
            );
            await declareWorldEdition(packagePath, locale);
            const loaded = await loadSingleWorld(packagePath);
            if (!loaded)
              throw new Error(
                `World "${worldId}" failed validation after translation`,
              );
            const next = withNewEdition(loaded, current, locale);
            await store.upsertWorld(next);
            // The record as the store gives it, in the shape of `GET /worlds/:id`.
            return (await store.getWorld(worldId)) ?? next;
          });
        if (!record) {
          await send({
            type: "error",
            message:
              "The world was deleted or replaced while it was translated",
          });
          return;
        }
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
        logRequestError(c, "[worlds/translate] unexpected error", err);
        const { body } = classifyApiError(
          err,
          readRuntimeEnv().nodeEnv !== "production",
        );
        await send({ type: "error", message: body.error });
      }
    });
  },
);
