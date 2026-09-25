/**
 * Plugin install route.
 *
 * POST /api/install/plugin — multipart (field `file`), accepts a.zip containing
 *   either a root-level PLUGIN.md + package.json, or runtimes/<sub>/PLUGIN.md
 *   entries (multi-runtime layout). Extracts to the user plugins dir and
 *   returns `{ ok, id, restartRequired: true }`.
 */

import path from "node:path";
import { Hono } from "hono";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { errorBody } from "../../../api-error.js";
import { withPackageMutation } from "./package-files.js";
import { validatePluginBundle } from "./plugin-bundle.js";
import {
  collectUpload,
  errorResponse,
  isBlobLike,
  materializeEntries,
  readAllEntries,
  rejectByContentLength,
} from "./shared.js";

export const pluginInstallRoutes = new Hono();

pluginInstallRoutes.post("/plugin", async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header("content-length"));
    if (tooLarge) throw tooLarge;

    const form = await c.req.formData();
    const file = form.get("file");
    if (!isBlobLike(file)) {
      return c.json(errorBody('multipart field "file" is required'), 400);
    }

    const buffer = await collectUpload(file);
    // First extract + validate against a throwaway sentinel root (path-traversal check
    // uses a fixed root string — entries get re-resolved under the final dir later).
    const entries = await readAllEntries(
      buffer,
      "/covel-plugin-install-sentinel",
    );
    // Reserved builtin ids are injected by the bootstrap DI middleware. Absent
    // only in bare test harnesses that mount the install routes directly — fall
    // back to an empty set so the route still functions there.
    const reservedPluginIds = c.get("reservedPluginIds") ?? new Set<string>();
    const summary = validatePluginBundle(entries, reservedPluginIds);

    const root = resolveUserResourceDirs().plugins;

    const finalDir = path.join(root, summary.pluginId);
    await withPackageMutation(summary.pluginId, () =>
      materializeEntries(finalDir, entries),
    );

    return c.json(
      {
        ok: true,
        kind: "plugin",
        id: summary.pluginId,
        restartRequired: true,
      },
      201,
    );
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});
