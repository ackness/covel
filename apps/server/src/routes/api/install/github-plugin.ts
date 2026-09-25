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
import { withPluginMutation } from "./plugin-files.js";
import {
  digestEntries,
  downloadGithubEntries,
  findPluginDirectories,
  parseGithubUrl,
  resolveGithubRevision,
  selectPluginEntries,
} from "./github-source.js";

export const githubPluginRoutes = new Hono();

githubPluginRoutes.post("/plugin/github/preview", async (c) => {
  try {
    const { url } = githubPluginPreviewRequestSchema.parse(await c.req.json());
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
    const items = findPluginDirectories(entries, location.directory).map(
      (directory) => {
        const bundle = selectPluginEntries(entries, directory);
        const preview = {
          ...inspectBundle(bundle, reserved),
          source: {
            repository: `https://github.com/${location.owner}/${location.repo}`,
            commit,
            path: directory,
            digest: digestEntries(bundle),
            tracking,
          },
          expiresAt: Date.now() + previewLifetime,
        };
        return {
          ...preview,
          token: signPreview({ action: "install", plugin: preview }),
        };
      },
    );
    return c.json({ items });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});

githubPluginRoutes.post("/plugin/github", async (c) => {
  try {
    const { token } = githubPluginInstallRequestSchema.parse(
      await c.req.json(),
    );
    const signed = verifyPreview(token);
    if (signed.action !== "install")
      throw httpError(400, "Expected an installation preview");
    const preview = signed.plugin;
    const location = parseGithubUrl(preview.source.repository);
    const archive = await downloadGithubEntries(
      location,
      preview.source.commit,
      c.req.raw.signal,
    );
    const entries = selectPluginEntries(archive, preview.source.path);
    if (digestEntries(entries) !== preview.source.digest)
      throw httpError(409, "Plugin content changed; parse and review it again");
    const summary = inspectBundle(
      entries,
      c.get("reservedPluginIds") ?? new Set<string>(),
    );
    if (summary.id !== preview.id)
      throw httpError(409, "Plugin identity changed");
    // Consent may have expired while the archive was downloading.
    verifyPreview(token);
    c.req.raw.signal.throwIfAborted();
    await withPluginMutation(summary.id, () =>
      materializeEntries(
        path.join(resolveUserResourceDirs().plugins, summary.id),
        [...entries, receiptEntry(preview)],
      ),
    );
    return c.json(
      { ok: true, kind: "plugin", id: summary.id, restartRequired: true },
      201,
    );
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});
