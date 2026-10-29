import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { isPathInside, readPlainYamlFrontmatter } from "@covel/plugin-loader";
import { resolveUserResourceDirs } from "./user-resource-dirs.js";
import { SAFE_WORLD_ID_RE } from "./validators.js";
import { findWorldPackageRoots } from "../world-data/session-import/utils.js";
import {
  installPluginId,
  unwrapPackageDirectory,
} from "../routes/api/install/plugin-bundle.js";
import {
  assertNoReservedInstallFiles,
  collectUpload,
  httpError,
  isBlobLike,
  materializeEntries,
  readAllEntries,
  readInstallationJson,
  rejectByContentLength,
  type ExtractedEntry,
} from "../routes/api/install/shared.js";

/** Resolve upload identity without admitting the package or executing its code. */
function uploadIdentity(
  kind: "plugin" | "world",
  entries: readonly ExtractedEntry[],
  directory: string | undefined,
  fileName: string | undefined,
): string | undefined {
  try {
    const manifest = entries.find(
      (entry) =>
        entry.relativePath === (kind === "plugin" ? "PLUGIN.md" : "world.yaml"),
    );
    if (!manifest) return undefined;
    if (kind === "plugin") {
      const frontmatter = readPlainYamlFrontmatter(
        manifest.content.toString("utf8"),
      ).data;
      const packageJson = entries.find(
        (entry) => entry.relativePath === "package.json",
      );
      let metadata: { name?: unknown } | undefined;
      try {
        if (packageJson)
          metadata = z
            .object({ name: z.unknown().optional() })
            .parse(JSON.parse(packageJson.content.toString("utf8")));
      } catch {
        // An unreadable package.json does not hide manifest diagnostics.
      }
      return installPluginId(frontmatter, directory, metadata);
    }
    const { id } = z
      .object({ id: z.unknown().optional() })
      .parse(parseYaml(manifest.content.toString("utf8")));
    const identity = id === undefined ? (directory ?? fileName) : id;
    return typeof identity === "string" && SAFE_WORLD_ID_RE.test(identity)
      ? identity
      : undefined;
  } catch {
    // The static validator reports invalid manifests as structured issues.
    return undefined;
  }
}

const sourceSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("installed"),
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        })
        .strict(),
      z.object({ kind: z.literal("path"), path: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export interface ValidationSource {
  dir: string;
  id?: string;
  cleanup(): Promise<void>;
}

export async function resolveValidationSource(
  c: Context,
  kind: "plugin" | "world",
  request: Request,
): Promise<ValidationSource> {
  const tooLarge = rejectByContentLength(
    request.headers.get("content-length") ?? undefined,
  );
  if (tooLarge) throw tooLarge;
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw httpError(400, "Invalid multipart upload");
    }
    const file = form.get("file");
    if (!isBlobLike(file)) throw httpError(400, "Missing file upload");
    let entries = await readAllEntries(
      await collectUpload(file),
      "/covel-validate-sentinel",
    );
    const pluginPackage =
      kind === "plugin" ? unwrapPackageDirectory(entries) : undefined;
    let directory = pluginPackage?.directory;
    if (pluginPackage) entries = [...pluginPackage.entries];
    else if (!entries.some((entry) => entry.relativePath === "world.yaml")) {
      const files = entries.filter(
        (entry) => !entry.relativePath.startsWith("__MACOSX/"),
      );
      const roots = new Set(
        files.map((entry) => entry.relativePath.split("/")[0]),
      );
      [directory] = roots;
      if (
        roots.size !== 1 ||
        !directory ||
        !files.some((entry) => entry.relativePath === `${directory}/world.yaml`)
      )
        throw httpError(400, "No root world.yaml found");
      const prefixLength = directory.length + 1;
      entries = files.map((entry) => ({
        ...entry,
        relativePath: entry.relativePath.slice(prefixLength),
      }));
    }
    assertNoReservedInstallFiles(entries);
    const fileName =
      "name" in file && typeof file.name === "string"
        ? path.parse(file.name).name
        : undefined;
    const id = uploadIdentity(kind, entries, directory, fileName);
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "covel-validate-"));
    const cleanup = () => rm(tmpRoot, { recursive: true, force: true });
    let dir = path.join(tmpRoot, "package");
    try {
      await materializeEntries(dir, entries);
      if (id) {
        // Static loading checks directory identity. Preserve it without rewriting
        // package bytes or using an author-controlled name for the temp root.
        const parent = path.join(tmpRoot, "identity");
        await mkdir(parent);
        const named = path.join(parent, id);
        await rename(dir, named);
        dir = named;
      }
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { dir, cleanup };
  }
  const { source } = sourceSchema.parse(await readInstallationJson(c));
  const user = resolveUserResourceDirs();
  const registry = c.get("pluginRegistry");
  const roots =
    kind === "plugin"
      ? [
          ...(registry
            ? [...registry.getAll().values()].flatMap((entry) =>
                entry.rootPath ? [path.dirname(entry.rootPath)] : [],
              )
            : []),
          user.plugins,
        ]
      : [...(c.get("worldsDirs") ?? []), user.worlds];
  let dir: string;
  if (source.kind === "installed") {
    if (kind === "plugin")
      dir =
        registry?.get(source.id)?.rootPath ??
        path.join(user.plugins, source.id);
    else {
      const matches = [
        ...new Set(
          (
            await Promise.all(
              [...new Set(roots)].map((root) =>
                findWorldPackageRoots(source.id, root),
              ),
            )
          ).flat(),
        ),
      ];
      if (matches.length > 1)
        throw httpError(409, "Several world packages declare this id");
      if (matches.length === 0) {
        // Settings lists installed directory names even when their manifests
        // cannot be parsed. Keep those packages available for diagnostics.
        for (const root of new Set(roots)) {
          const candidate = path.join(root, source.id);
          if (await lstat(candidate).catch(() => undefined))
            matches.push(candidate);
        }
        if (matches.length > 1)
          throw httpError(
            409,
            "Several installed world directories have this id",
          );
      }
      const [match] = matches;
      if (!match) throw httpError(404, "Package not found");
      dir = match;
    }
  } else dir = path.resolve(source.path);
  const resolvedRoots = await Promise.all(
    roots.map((root) => realpath(root).catch(() => path.resolve(root))),
  );
  const resolved = await realpath(dir).catch(() => path.resolve(dir));
  if (!resolvedRoots.some((root) => isPathInside(root, resolved)))
    throw httpError(403, "path-outside-roots");
  const stat = await lstat(dir).catch(() => undefined);
  if (!stat) throw httpError(404, "Package not found");
  if (stat.isSymbolicLink())
    throw httpError(400, "Symlinked package root is not allowed");
  if (!stat.isDirectory())
    throw httpError(400, "Package path must be a directory");
  return {
    dir: resolved,
    ...(source.kind === "installed" ? { id: source.id } : {}),
    cleanup: async () => {},
  };
}
