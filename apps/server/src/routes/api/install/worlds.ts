/**
 * World install route.
 *
 * POST /api/install/world — multipart (field `file`), accepts a .zip containing
 *   world.yaml + WORLD.md at the root. Extracts to the user worlds dir and
 *   returns `{ ok, id, restartRequired: false }` (worlds reload on demand).
 */

import { homedir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import {
  readRuntimeEnv,
  validateWorldManifest,
  formatValidationErrors,
} from "@covel/shared";
import {
  SAFE_WORLD_ID_RE,
  SAFE_WORLD_ID_DESC,
} from "../../../lib/validators.js";
import {
  collectUpload,
  errorResponse,
  httpError,
  isBlobLike,
  materializeEntries,
  readAllEntries,
  rejectByContentLength,
  type ExtractedEntry,
} from "./shared.js";

export const worldInstallRoutes = new Hono();

interface WorldManifestSummary {
  readonly worldId: string;
}

function findWorldYaml(
  entries: readonly ExtractedEntry[],
): ExtractedEntry | null {
  return entries.find((e) => e.relativePath === "world.yaml") ?? null;
}

function validateWorldBundle(
  entries: readonly ExtractedEntry[],
): WorldManifestSummary {
  const yamlEntry = findWorldYaml(entries);
  if (!yamlEntry) {
    throw httpError(400, "world.yaml not found at zip root");
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlEntry.content.toString("utf-8"));
  } catch (parseErr) {
    throw httpError(
      400,
      `world.yaml parse error: ${(parseErr as Error).message}`,
    );
  }

  const result = validateWorldManifest(raw);
  if (!result.valid) {
    throw httpError(
      400,
      `invalid world.yaml:\n${formatValidationErrors(result.errors ?? [])}`,
    );
  }

  const manifest = result.data as { id?: unknown };
  if (typeof manifest.id !== "string" || !SAFE_WORLD_ID_RE.test(manifest.id)) {
    throw httpError(400, `world.yaml \`id\` must match ${SAFE_WORLD_ID_DESC}`);
  }

  return { worldId: manifest.id };
}

worldInstallRoutes.post("/world", async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header("content-length"));
    if (tooLarge) throw tooLarge;

    const form = await c.req.formData();
    const file = form.get("file");
    if (!isBlobLike(file)) {
      return c.json({ error: 'multipart field "file" is required' }, 400);
    }

    const buffer = await collectUpload(file);
    const entries = await readAllEntries(
      buffer,
      "/covel-world-install-sentinel",
    );
    const summary = validateWorldBundle(entries);

    const env = readRuntimeEnv();
    const root =
      env.userWorldsDir ??
      (env.covelHome
        ? path.join(env.covelHome, "worlds")
        : path.join(homedir(), ".covel", "worlds"));

    const finalDir = path.join(root, summary.worldId);
    await materializeEntries(finalDir, entries);

    return c.json({
      ok: true,
      kind: "world",
      id: summary.worldId,
      restartRequired: false,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});
