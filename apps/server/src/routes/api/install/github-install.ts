import path from "node:path";
import { Hono } from "hono";
import {
  githubPluginInstallRequestSchema,
  githubPluginPreviewRequestSchema,
} from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { errorResponse, httpError, materializeEntries } from "./shared.js";
import {
  inspectBundle,
  previewLifetime,
  receiptEntry,
  signPreview,
  verifyPreview,
} from "./github-preview.js";
import { withPackageMutation } from "./package-files.js";
import {
  digestEntries,
  downloadGithubEntries,
  findPluginDirectories,
  parseGithubUrl,
  resolveGithubRevision,
  selectPackageEntries,
} from "./github-source.js";

import { findWorldDirectories, inspectWorldBundle } from "./github-world.js";
import { activateWorldPackage } from "./worlds.js";
import { checkWorldWriteAccess } from "../worlds/world-write-guard.js";

export function createGithubInstallRoutes(kind: "plugin" | "world") {
  const githubPluginRoutes = new Hono();
  const action = kind === "world" ? "world-install" : "install";
  const findDirectories =
    kind === "world" ? findWorldDirectories : findPluginDirectories;
  const inspect = kind === "world" ? inspectWorldBundle : inspectBundle;
  githubPluginRoutes.use("*", async (c, next) => {
    if (kind === "world") {
      const denied = checkWorldWriteAccess(c);
      if (denied) return denied;
    }
    await next();
  });

  githubPluginRoutes.post(`/${kind}/github/preview`, async (c) => {
    try {
      const { url } = githubPluginPreviewRequestSchema.parse(
        await c.req.json(),
      );
      const location = parseGithubUrl(url);
      const { commit, tracking } = await resolveGithubRevision(
        location,
        c.req.raw.signal,
      );
      const entries = await downloadGithubEntries(
        location,
        commit,
        c.req.raw.signal,
      );
      const reserved = c.get("reservedPluginIds") ?? new Set<string>();
      const items = [];
      for (const directory of findDirectories(entries, location.directory)) {
        const bundle = selectPackageEntries(entries, directory);
        const preview = {
          ...(await inspect(bundle, reserved)),
          source: {
            repository: `https://github.com/${location.owner}/${location.repo}`,
            commit,
            path: directory,
            digest: digestEntries(bundle),
            tracking,
          },
          expiresAt: Date.now() + previewLifetime,
        };
        items.push({
          ...preview,
          token: signPreview({ action, plugin: preview }),
        });
      }
      return c.json({ items });
    } catch (error) {
      const { status, body } = errorResponse(error);
      return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
    }
  });

  githubPluginRoutes.post(`/${kind}/github`, async (c) => {
    try {
      const { token } = githubPluginInstallRequestSchema.parse(
        await c.req.json(),
      );
      const signed = verifyPreview(token);
      if (signed.action !== action)
        throw httpError(400, "Expected an installation preview");
      const preview = signed.plugin;
      const location = parseGithubUrl(preview.source.repository);
      const archive = await downloadGithubEntries(
        location,
        preview.source.commit,
        c.req.raw.signal,
      );
      const entries = selectPackageEntries(archive, preview.source.path);
      if (digestEntries(entries) !== preview.source.digest)
        throw httpError(
          409,
          "Package content changed; parse and review it again",
        );
      const summary = await inspect(
        entries,
        c.get("reservedPluginIds") ?? new Set<string>(),
      );
      if (summary.id !== preview.id)
        throw httpError(409, "Package identity changed");
      // Consent may have expired while the archive was downloading.
      verifyPreview(token);
      c.req.raw.signal.throwIfAborted();
      const root =
        resolveUserResourceDirs()[kind === "world" ? "worlds" : "plugins"];
      await withPackageMutation(
        summary.id,
        () =>
          kind === "world"
            ? activateWorldPackage(c, summary.id, [
                ...entries,
                receiptEntry(preview),
              ])
            : materializeEntries(path.join(root, summary.id), [
                ...entries,
                receiptEntry(preview),
              ]),
        root,
      );
      return c.json(
        { ok: true, kind, id: summary.id, restartRequired: kind === "plugin" },
        201,
      );
    } catch (error) {
      const { status, body } = errorResponse(error);
      return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
    }
  });

  return githubPluginRoutes;
}
