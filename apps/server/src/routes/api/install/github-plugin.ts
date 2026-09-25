import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  githubPluginInstallRequestSchema,
  githubPluginPreviewRequestSchema,
  githubPluginPreviewSchema,
  type GithubPluginPreview,
} from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import {
  errorResponse,
  httpError,
  materializeEntries,
  type ExtractedEntry,
} from "./shared.js";
import {
  readPluginFrontmatter,
  validatePluginBundle,
} from "./plugin-bundle.js";
import {
  digestEntries,
  downloadGithubEntries,
  findPluginDirectories,
  parseGithubUrl,
  resolveGithubCommit,
  selectPluginEntries,
} from "./github-source.js";

const receiptFile = ".covel-install.json";
// Short-lived, signed previews bind consent to exact content without keeping
// downloaded untrusted archives in memory or in a second install directory.
const signingKey = randomBytes(32);
const previewLifetime = 15 * 60_000;
const signedPreviewSchema = githubPluginPreviewSchema.omit({ token: true });

function sign(data: Omit<GithubPluginPreview, "token">): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${createHmac("sha256", signingKey).update(payload).digest("base64url")}`;
}

function verify(token: string): Omit<GithubPluginPreview, "token"> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra)
    throw httpError(400, "Invalid install preview");
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw httpError(400, "Invalid install preview; parse the repository again");
  const preview = signedPreviewSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (preview.expiresAt <= Date.now())
    throw httpError(409, "Install preview expired; parse the repository again");
  return preview;
}

function inspectBundle(
  entries: readonly ExtractedEntry[],
  reserved: ReadonlySet<string>,
) {
  const { pluginId } = validatePluginBundle(entries, reserved);
  const pkg = z
    .object({
      version: z.string().max(100).optional(),
      dependencies: z.record(z.string(), z.unknown()).optional(),
      optionalDependencies: z.record(z.string(), z.unknown()).optional(),
      peerDependencies: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(
      JSON.parse(
        entries
          .find((e) => e.relativePath === "package.json")!
          .content.toString("utf8"),
      ),
    );
  if (
    [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].some(
      (deps) => deps && Object.keys(deps).length > 0,
    )
  ) {
    throw httpError(
      400,
      "Plugin must ship self-contained runtime files without runtime dependencies; the installer never runs package managers or build scripts",
    );
  }
  const manifest =
    entries.find((e) => e.relativePath === "PLUGIN.md") ??
    entries.find((e) => /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath))!;
  const data = readPluginFrontmatter(manifest.content.toString("utf8"));
  const localized = z
    .record(z.string(), z.string())
    .safeParse(data.description);
  const description =
    typeof data.description === "string"
      ? data.description
      : localized.success
        ? (localized.data["en-US"] ??
          localized.data.en ??
          localized.data["zh-CN"] ??
          localized.data.zh ??
          "")
        : "";
  return {
    id: pluginId,
    version: pkg.version ?? null,
    description: description.slice(0, 1000),
    hasServerCode:
      entries.some((e) =>
        /\.(?:[cm]?js|tsx?|node|wasm)$/i.test(e.relativePath),
      ) ||
      entries
        .filter((e) => e.relativePath.endsWith("PLUGIN.md"))
        .some((e) => {
          const manifest = readPluginFrontmatter(e.content.toString("utf8"));
          return !!(
            manifest.entry ||
            manifest.handler ||
            manifest.guard ||
            manifest.tools
          );
        }),
  };
}

export const githubPluginRoutes = new Hono();

githubPluginRoutes.post("/plugin/github/preview", async (c) => {
  try {
    const { url } = githubPluginPreviewRequestSchema.parse(await c.req.json());
    const location = parseGithubUrl(url);
    const commit = await resolveGithubCommit(location, c.req.raw.signal);
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
          },
          expiresAt: Date.now() + previewLifetime,
        };
        return { ...preview, token: sign(preview) };
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
    const preview = verify(token);
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
    verify(token);
    c.req.raw.signal.throwIfAborted();
    await materializeEntries(
      path.join(resolveUserResourceDirs().plugins, summary.id),
      [
        ...entries,
        {
          relativePath: receiptFile,
          content: Buffer.from(
            JSON.stringify(
              {
                source: preview.source,
                version: summary.version,
                installedAt: new Date().toISOString(),
              },
              null,
              2,
            ) + "\n",
          ),
        },
      ],
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
