import path from "node:path";
import { Hono, type Context } from "hono";
import {
  githubPluginInstallRequestSchema,
  githubPluginUpdateCheckRequestSchema,
  pluginInstallIdSchema,
} from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import {
  digestEntries,
  downloadGithubEntries,
  parseGithubUrl,
  resolveGithubCommit,
  resolveGithubRevision,
  selectPackageEntries,
  type GithubLocation,
} from "./github-source.js";
import {
  inspectBundle,
  previewLifetime,
  receiptEntry,
  signPreview,
  verifyPreview,
} from "./github-preview.js";
import {
  packageReceiptSchema,
  readUnmodifiedPackage,
  withPackageMutation,
} from "./package-files.js";
import {
  cancelPackageUpdate,
  pendingPackageUpdate,
  queuePackageUpdate,
} from "./package-updates.js";
import { errorResponse, httpError, type ExtractedEntry } from "./shared.js";

function compareFiles(
  previous: readonly ExtractedEntry[],
  next: readonly ExtractedEntry[],
) {
  const before = new Map(
    previous.map((entry) => [entry.relativePath, entry.content]),
  );
  const after = new Map(
    next.map((entry) => [entry.relativePath, entry.content]),
  );
  return {
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    modified: [...after.keys()]
      .filter(
        (name) =>
          before.has(name) && !before.get(name)!.equals(after.get(name)!),
      )
      .sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
  };
}

import { inspectWorldBundle } from "./github-world.js";
import { checkWorldWriteAccess } from "../worlds/world-write-guard.js";
import {
  worldOperationLockId,
  isWorldDeleting,
} from "../../../world-lifecycle.js";

export async function assertWorldPackageUpdate(c: Context, id: string) {
  const world = await c.get("store").getWorld(id);
  if (!world || !world.metadata?.packageManaged || isWorldDeleting(world))
    throw httpError(409, "Only installed GitHub worlds can be updated");
  if (world.metadata.packageModified)
    throw httpError(
      409,
      "World was edited locally; export and resolve your changes before updating",
    );
}

export function createGithubUpdateRoutes(kind: "plugin" | "world") {
  const githubUpdateRoutes = new Hono();
  const action = kind === "world" ? "world-update" : "update";
  const inspect = kind === "world" ? inspectWorldBundle : inspectBundle;
  const resourceRoot = () =>
    resolveUserResourceDirs()[kind === "world" ? "worlds" : "plugins"];
  githubUpdateRoutes.use("*", async (c, next) => {
    if (kind === "world") {
      const denied = checkWorldWriteAccess(c);
      if (denied) return denied;
    }
    await next();
  });

  githubUpdateRoutes.post(`/${kind}/github/update/preview`, async (c) => {
    try {
      const { id, url } = githubPluginUpdateCheckRequestSchema.parse(
        await c.req.json(),
      );
      const root = resourceRoot();
      const reserved = c.get("reservedPluginIds") ?? new Set<string>();
      if (kind === "plugin" && reserved.has(id))
        throw httpError(409, "Builtin plugins update with Covel");
      if (await pendingPackageUpdate(root, id))
        throw httpError(
          409,
          "An update is already queued; restart or cancel it first",
        );
      const { receipt, entries: previousEntries } = await readUnmodifiedPackage(
        path.join(root, id),
      );
      if (kind === "world") await assertWorldPackageUpdate(c, id);
      const source = receipt.source;
      let location: GithubLocation;
      let revision;
      if (url) {
        location = parseGithubUrl(url);
        if (
          `https://github.com/${location.owner}/${location.repo}` !==
            source.repository ||
          location.directory !== source.path
        )
          throw httpError(
            409,
            "Update URL must use the installed repository and package directory",
          );
        revision = await resolveGithubRevision(location, c.req.raw.signal);
      } else {
        if (source.tracking.kind === "pinned")
          return c.json({ status: "pinned" });
        location = {
          ...parseGithubUrl(source.repository),
          directory: source.path,
          ...(source.tracking.kind === "branch"
            ? { ref: source.tracking.ref }
            : {}),
        };
        if (source.tracking.kind === "branch") {
          revision = await resolveGithubRevision(location, c.req.raw.signal);
          if (revision.tracking.kind !== "branch")
            throw httpError(
              409,
              "Tracked branch no longer exists; choose a version explicitly",
            );
        } else
          revision = {
            commit: await resolveGithubCommit(location, c.req.raw.signal),
            tracking: source.tracking,
          };
      }
      const archive = await downloadGithubEntries(
        location,
        revision.commit,
        c.req.raw.signal,
      );
      const entries = selectPackageEntries(archive, source.path);
      const summary = await inspect(entries, reserved);
      if (summary.id !== id)
        throw httpError(
          409,
          "Updated package identity does not match the installed package",
        );
      const digest = digestEntries(entries);
      if (digest === source.digest) return c.json({ status: "current" });
      const plugin = {
        ...summary,
        source: { ...source, ...revision, digest },
        expiresAt: Date.now() + previewLifetime,
      };
      return c.json({
        status: "available",
        preview: {
          ...plugin,
          previous: { version: receipt.version, source },
          changes: compareFiles(previousEntries, entries),
          token: signPreview({ action, plugin, previous: receipt }),
        },
      });
    } catch (error) {
      const { status, body } = errorResponse(error);
      return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
    }
  });

  githubUpdateRoutes.post(`/${kind}/github/update`, async (c) => {
    try {
      const { token } = githubPluginInstallRequestSchema.parse(
        await c.req.json(),
      );
      const signed = verifyPreview(token);
      if (signed.action !== action || !("previous" in signed))
        throw httpError(400, "Expected an update preview");
      const { plugin, previous } = signed;
      const root = resourceRoot();
      // Check before download, and again under the mutation lock before staging.
      await readUnmodifiedPackage(path.join(root, plugin.id), previous);
      const archive = await downloadGithubEntries(
        parseGithubUrl(plugin.source.repository),
        plugin.source.commit,
        c.req.raw.signal,
      );
      const entries = selectPackageEntries(archive, plugin.source.path);
      if (digestEntries(entries) !== plugin.source.digest)
        throw httpError(
          409,
          "Package content changed; check for updates again",
        );
      const summary = await inspect(
        entries,
        c.get("reservedPluginIds") ?? new Set<string>(),
      );
      if (summary.id !== plugin.id)
        throw httpError(409, "Package identity changed");
      verifyPreview(token);
      c.req.raw.signal.throwIfAborted();
      const receipt = receiptEntry(plugin);
      const next = packageReceiptSchema.parse(
        JSON.parse(receipt.content.toString("utf8")),
      );
      const queue = async () => {
        if (kind === "world") await assertWorldPackageUpdate(c, plugin.id);
        await queuePackageUpdate(root, plugin.id, previous, next, [
          ...entries,
          receipt,
        ]);
      };
      if (kind === "world")
        await c
          .get("sessionLock")
          .withLock(worldOperationLockId(plugin.id), queue);
      else await queue();
      return c.json(
        { ok: true, kind, id: plugin.id, restartRequired: true },
        201,
      );
    } catch (error) {
      const { status, body } = errorResponse(error);
      return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
    }
  });

  githubUpdateRoutes.delete(`/${kind}/github/update/:id`, async (c) => {
    try {
      const id = pluginInstallIdSchema.parse(c.req.param("id"));
      const root = resourceRoot();
      await withPackageMutation(id, () => cancelPackageUpdate(root, id), root);
      return c.json({ ok: true });
    } catch (error) {
      const { status, body } = errorResponse(error);
      return c.json(body, status as 400 | 409 | 500);
    }
  });

  return githubUpdateRoutes;
}
