import path from "node:path";
import { Hono } from "hono";
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
  selectPluginEntries,
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
  pluginReceiptSchema,
  readUnmodifiedPlugin,
  withPluginMutation,
} from "./plugin-files.js";
import {
  cancelPluginUpdate,
  pendingPluginUpdate,
  queuePluginUpdate,
} from "./plugin-updates.js";
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

export const githubUpdateRoutes = new Hono();

githubUpdateRoutes.post("/plugin/github/update/preview", async (c) => {
  try {
    const { id, url } = githubPluginUpdateCheckRequestSchema.parse(
      await c.req.json(),
    );
    const root = resolveUserResourceDirs().plugins;
    const reserved = c.get("reservedPluginIds") ?? new Set<string>();
    if (reserved.has(id))
      throw httpError(409, "Builtin plugins update with Covel");
    if (await pendingPluginUpdate(root, id))
      throw httpError(
        409,
        "An update is already queued; restart or cancel it first",
      );
    const { receipt, entries: previousEntries } = await readUnmodifiedPlugin(
      path.join(root, id),
    );
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
          "Update URL must use the installed repository and plugin directory",
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
    const entries = selectPluginEntries(archive, source.path);
    const summary = inspectBundle(entries, reserved);
    if (summary.id !== id)
      throw httpError(
        409,
        "Updated package identity does not match the installed plugin",
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
        token: signPreview({ action: "update", plugin, previous: receipt }),
      },
    });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});

githubUpdateRoutes.post("/plugin/github/update", async (c) => {
  try {
    const { token } = githubPluginInstallRequestSchema.parse(
      await c.req.json(),
    );
    const signed = verifyPreview(token);
    if (signed.action !== "update")
      throw httpError(400, "Expected an update preview");
    const { plugin, previous } = signed;
    const root = resolveUserResourceDirs().plugins;
    // Check before download, and again under the mutation lock before staging.
    await readUnmodifiedPlugin(path.join(root, plugin.id), previous);
    const archive = await downloadGithubEntries(
      parseGithubUrl(plugin.source.repository),
      plugin.source.commit,
      c.req.raw.signal,
    );
    const entries = selectPluginEntries(archive, plugin.source.path);
    if (digestEntries(entries) !== plugin.source.digest)
      throw httpError(409, "Plugin content changed; check for updates again");
    const summary = inspectBundle(
      entries,
      c.get("reservedPluginIds") ?? new Set<string>(),
    );
    if (summary.id !== plugin.id)
      throw httpError(409, "Plugin identity changed");
    verifyPreview(token);
    c.req.raw.signal.throwIfAborted();
    const receipt = receiptEntry(plugin);
    const next = pluginReceiptSchema.parse(
      JSON.parse(receipt.content.toString("utf8")),
    );
    await queuePluginUpdate(root, plugin.id, previous, next, [
      ...entries,
      receipt,
    ]);
    return c.json(
      { ok: true, kind: "plugin", id: plugin.id, restartRequired: true },
      201,
    );
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});

githubUpdateRoutes.delete("/plugin/github/update/:id", async (c) => {
  try {
    const id = pluginInstallIdSchema.parse(c.req.param("id"));
    const root = resolveUserResourceDirs().plugins;
    await withPluginMutation(id, () => cancelPluginUpdate(root, id), root);
    return c.json({ ok: true });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 409 | 500);
  }
});
