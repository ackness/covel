/**
 * One preview and one atomic install for everything under a GitHub URL.
 *
 * A directory holding `covel-collection.yaml` installs exactly the packages the
 * manifest lists, including ones pinned in other repositories. Any other
 * directory offers every plugin and world found in it. Either way the result
 * is ordinary plugins and ordinary worlds: each item carries the same signed
 * preview token the single-package routes issue, so consent, digest checks and
 * receipts are unchanged.
 */

import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { parse as parseYaml } from "yaml";
import {
  COLLECTION_MANIFEST_FILE,
  COLLECTION_MEMBER_LIMIT,
  checkCollection,
  collectionManifestSchema,
  collectionPluginFacts,
  collectionWorldFacts,
  githubBatchInstallRequestSchema,
  githubPluginPreviewRequestSchema,
  providedContracts,
  type CollectionManifest,
  type CollectionMember,
  type CollectionPluginFacts,
  type CollectionProblem,
  type CollectionWorldFacts,
  type GithubCollectionPreview,
  type GithubPackagePreview,
} from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import { APP_VERSION } from "../../../lib/app-version.js";
import { checkWorldWriteAccess } from "../worlds/world-write-guard.js";
import {
  inspectBundle,
  previewLifetime,
  receiptEntry,
  signPreview,
  verifyPreview,
} from "./github-preview.js";
import {
  digestEntries,
  downloadGithubEntries,
  findPluginDirectories,
  parseGithubUrl,
  resolveGithubRevision,
  selectPackageEntries,
  type GithubLocation,
} from "./github-source.js";
import { findWorldDirectories, inspectWorldBundle } from "./github-world.js";
import { withPackageMutation } from "./package-files.js";
import {
  readPluginFrontmatter,
  validatePluginBundle,
} from "./plugin-bundle.js";
import {
  collectUpload,
  errorResponse,
  httpError,
  isBlobLike,
  materializeEntries,
  readAllEntries,
  rejectByContentLength,
  type ExtractedEntry,
  type HttpError,
} from "./shared.js";
import { activateWorldPackage } from "./worlds.js";

type Kind = "plugin" | "world";
type Tracking = GithubPackagePreview["source"]["tracking"];

/** Where one package's files come from. */
interface MemberSource {
  readonly kind: Kind;
  readonly location: GithubLocation;
  readonly commit: string;
  readonly tracking: Tracking;
  readonly directory: string;
  readonly archive: readonly ExtractedEntry[];
}

const repositoryUrl = (location: GithubLocation) =>
  `https://github.com/${location.owner}/${location.repo}`;

/** "Nothing of this kind here" is an empty list in a mixed preview. */
function discover(find: () => string[]): string[] {
  try {
    return find();
  } catch (error) {
    if (
      (error as Partial<HttpError>).httpStatus === 400 &&
      /^No (plugin|world)/.test((error as Error).message)
    )
      return [];
    throw error;
  }
}

/** Read from the manifest the bundle inspector has already validated. */
const pluginFacts = (entries: readonly ExtractedEntry[]) =>
  collectionPluginFacts(
    readPluginFrontmatter(
      entries
        .find((entry) => entry.relativePath === "PLUGIN.md")!
        .content.toString("utf8"),
    ),
  );
const worldFacts = (entries: readonly ExtractedEntry[]) =>
  collectionWorldFacts(
    parseYaml(
      entries
        .find((entry) => entry.relativePath === "world.yaml")!
        .content.toString("utf8"),
    ) as Record<string, unknown>,
  );

/** Plugins this host already has, as far as resolving a set is concerned. */
function availablePlugins(c: Context): CollectionPluginFacts[] {
  const registry = c.get("pluginRegistry");
  if (!registry) return [];
  return [...registry.getAll().values()].map((entry) => {
    const summary = buildPluginSummary(entry);
    return { id: summary.id, contracts: providedContracts(summary) };
  });
}

function parseCollectionManifest(entry: ExtractedEntry): CollectionManifest {
  const parsed = collectionManifestSchema.safeParse(
    parseYaml(entry.content.toString("utf8")),
  );
  if (!parsed.success)
    throw httpError(
      400,
      `Invalid ${COLLECTION_MANIFEST_FILE}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`.trim())
        .join("; ")}`,
    );
  return parsed.data;
}

interface PreparedPackage {
  readonly kind: Kind;
  readonly id: string;
  readonly entries: readonly ExtractedEntry[];
}

/**
 * Install validated packages as a unit. Nothing is written when a target
 * already exists. Plugins are promoted first, then worlds; any failure removes
 * what this call promoted. That is safe because plugin code is not loaded
 * before the restart, and a world activated a moment ago has no sessions.
 */
async function installPrepared(
  c: Context,
  prepared: readonly PreparedPackage[],
) {
  const dirs = resolveUserResourceDirs();
  for (const item of prepared) {
    const taken =
      item.kind === "world"
        ? Boolean(await c.get("store").getWorld(item.id))
        : await lstat(path.join(dirs.plugins, item.id)).then(
            () => true,
            () => false,
          );
    if (taken)
      throw httpError(
        409,
        `The ${item.kind} ${item.id} is already installed; nothing was changed`,
      );
  }
  const done: { kind: Kind; id: string }[] = [];
  try {
    for (const kind of ["plugin", "world"] as const)
      for (const item of prepared.filter((entry) => entry.kind === kind)) {
        const root = kind === "world" ? dirs.worlds : dirs.plugins;
        await withPackageMutation(
          item.id,
          () =>
            kind === "world"
              ? activateWorldPackage(c, item.id, item.entries)
              : materializeEntries(path.join(root, item.id), item.entries),
          root,
        );
        done.push({ kind, id: item.id });
      }
  } catch (error) {
    for (const item of [...done].reverse()) {
      const root = item.kind === "world" ? dirs.worlds : dirs.plugins;
      try {
        if (item.kind === "world") await c.get("store").deleteWorld(item.id);
        await rm(path.join(root, item.id), { recursive: true, force: true });
      } catch (rollbackError) {
        console.error(
          `[install] ${c.req.method} ${c.req.url}: could not roll back ${item.kind} ${item.id}`,
          rollbackError,
        );
      }
    }
    throw error;
  }
  return {
    ok: true as const,
    installed: done,
    restartRequired: done.some((item) => item.kind === "plugin"),
  };
}

export const githubCollectionRoutes = new Hono();

githubCollectionRoutes.post("/github/preview", async (c) => {
  try {
    const { url } = githubPluginPreviewRequestSchema.parse(await c.req.json());
    const signal = c.req.raw.signal;
    const location = parseGithubUrl(url);
    const { commit, tracking } = await resolveGithubRevision(location, signal);
    const archive = await downloadGithubEntries(location, commit, signal);
    const problems: CollectionProblem[] = [];
    const worldsAllowed = !checkWorldWriteAccess(c);

    const manifestEntry = selectPackageEntries(
      archive,
      location.directory,
    ).find((entry) => entry.relativePath === COLLECTION_MANIFEST_FILE);
    let manifest: CollectionManifest | undefined;
    const members: MemberSource[] = [];
    if (manifestEntry) {
      manifest = parseCollectionManifest(manifestEntry);
      // One download per pinned repository, however many members it holds.
      const external = new Map<string, Promise<ExtractedEntry[]>>();
      const resolveMember = async (
        kind: Kind,
        member: CollectionMember,
      ): Promise<MemberSource> => {
        if (!("repository" in member))
          return {
            kind,
            location,
            commit,
            tracking,
            archive,
            directory: [location.directory, member.path]
              .filter(Boolean)
              .join("/"),
          };
        const other = parseGithubUrl(`https://github.com/${member.repository}`);
        const key = `${member.repository}@${member.commit}`;
        if (!external.has(key))
          external.set(
            key,
            downloadGithubEntries(other, member.commit, signal),
          );
        return {
          kind,
          location: other,
          commit: member.commit,
          tracking: { kind: "pinned", ref: member.commit },
          archive: await external.get(key)!,
          directory: member.path ?? "",
        };
      };
      for (const member of manifest.plugins)
        members.push(await resolveMember("plugin", member));
      for (const member of manifest.worlds)
        members.push(await resolveMember("world", member));
    } else {
      const here = (kind: Kind, directory: string): MemberSource => ({
        kind,
        location,
        commit,
        tracking,
        archive,
        directory,
      });
      for (const directory of discover(() =>
        findPluginDirectories(archive, location.directory),
      ))
        members.push(here("plugin", directory));
      for (const directory of discover(() =>
        findWorldDirectories(archive, location.directory),
      ))
        members.push(here("world", directory));
      if (members.length === 0)
        throw httpError(
          400,
          `No plugin, world, or ${COLLECTION_MANIFEST_FILE} found in this directory`,
        );
      if (members.length > COLLECTION_MEMBER_LIMIT)
        throw httpError(
          400,
          "Too many packages; paste a more specific directory URL",
        );
    }

    const reserved = c.get("reservedPluginIds") ?? new Set<string>();
    const items: GithubPackagePreview[] = [];
    const plugins: CollectionPluginFacts[] = [];
    const worlds: CollectionWorldFacts[] = [];
    const skipped: string[] = [];
    for (const member of members) {
      if (member.kind === "world" && !worldsAllowed) {
        problems.push({
          level: "warning",
          message: `The world in ${member.directory || "/"} is left out: this host does not let you install worlds.`,
        });
        continue;
      }
      const bundle = selectPackageEntries(member.archive, member.directory);
      let summary: Awaited<ReturnType<typeof inspectWorldBundle>>;
      try {
        summary =
          member.kind === "world"
            ? await inspectWorldBundle(bundle)
            : inspectBundle(bundle, reserved);
      } catch (error) {
        // A manifest names its members, so a broken one breaks the collection.
        // A directory scan merely found this package: say why it is left out
        // and keep the others installable.
        if (manifest) throw error;
        skipped.push(
          `${member.directory || "/"} is left out: ${errorResponse(error).body.error.slice(0, 300)}`,
        );
        continue;
      }
      if (member.kind === "world") worlds.push(worldFacts(bundle));
      else plugins.push(pluginFacts(bundle));
      const preview = {
        ...summary,
        source: {
          repository: repositoryUrl(member.location),
          commit: member.commit,
          path: member.directory,
          digest: digestEntries(bundle),
          tracking: member.tracking,
        },
        expiresAt: Date.now() + previewLifetime,
      };
      items.push({
        ...preview,
        kind: member.kind,
        token: signPreview({
          action: member.kind === "world" ? "world-install" : "install",
          plugin: preview,
        }),
      });
    }

    if (items.length === 0 && skipped.length > 0)
      throw httpError(400, `Nothing here can be installed. ${skipped[0]}`);
    problems.push(
      ...skipped.map((message) => ({ level: "warning" as const, message })),
      ...checkCollection({
        worlds,
        plugins,
        available: availablePlugins(c),
        hostVersion: APP_VERSION,
        collectionRange: manifest?.covel,
      }),
    );
    const body: GithubCollectionPreview = {
      collection: manifest
        ? {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version ?? null,
          }
        : null,
      items,
      problems,
    };
    return c.json(body);
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});

githubCollectionRoutes.post("/github/batch", async (c) => {
  try {
    const { tokens } = githubBatchInstallRequestSchema.parse(
      await c.req.json(),
    );
    const signal = c.req.raw.signal;
    const reserved = c.get("reservedPluginIds") ?? new Set<string>();

    // Phase 1 writes nothing: every package is downloaded, matched against the
    // digest the user reviewed, and validated before the first file lands.
    const archives = new Map<string, Promise<ExtractedEntry[]>>();
    const prepared: PreparedPackage[] = [];
    for (const token of new Set(tokens)) {
      const signed = verifyPreview(token);
      if (signed.action !== "install" && signed.action !== "world-install")
        throw httpError(400, "Expected an installation preview");
      const kind: Kind = signed.action === "world-install" ? "world" : "plugin";
      if (kind === "world") {
        const denied = checkWorldWriteAccess(c);
        if (denied) return denied;
      }
      const preview = signed.plugin;
      const key = `${preview.source.repository}@${preview.source.commit}`;
      if (!archives.has(key))
        archives.set(
          key,
          downloadGithubEntries(
            parseGithubUrl(preview.source.repository),
            preview.source.commit,
            signal,
          ),
        );
      const entries = selectPackageEntries(
        await archives.get(key)!,
        preview.source.path,
      );
      if (digestEntries(entries) !== preview.source.digest)
        throw httpError(
          409,
          "Package content changed; parse and review it again",
        );
      const summary =
        kind === "world"
          ? await inspectWorldBundle(entries)
          : inspectBundle(entries, reserved);
      if (summary.id !== preview.id)
        throw httpError(409, "Package identity changed");
      if (prepared.some((item) => item.kind === kind && item.id === summary.id))
        throw httpError(400, `The ${kind} ${summary.id} is listed twice`);
      prepared.push({
        kind,
        id: summary.id,
        entries: [...entries, receiptEntry(preview)],
      });
    }
    // Consent may have expired while archives were downloading.
    for (const token of tokens) verifyPreview(token);
    signal.throwIfAborted();
    return c.json(await installPrepared(c, prepared), 201);
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 404 | 409 | 413 | 429 | 502);
  }
});

/**
 * Offline import of a packed collection: one ZIP holding the manifest and every
 * member. There is no preview step, so the completeness check that a GitHub
 * preview reports is enforced here before anything is written.
 */
githubCollectionRoutes.post("/collection", async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header("content-length"));
    if (tooLarge) throw tooLarge;
    const file = (await c.req.formData()).get("file");
    if (!isBlobLike(file))
      throw httpError(400, 'multipart field "file" is required');
    const entries = await readAllEntries(
      await collectUpload(file),
      "/covel-collection-install-sentinel",
    );
    const manifestEntry = entries.find(
      (entry) => entry.relativePath === COLLECTION_MANIFEST_FILE,
    );
    if (!manifestEntry)
      throw httpError(
        400,
        `${COLLECTION_MANIFEST_FILE} must be at the top level of the ZIP`,
      );
    const manifest = parseCollectionManifest(manifestEntry);
    const reserved = c.get("reservedPluginIds") ?? new Set<string>();
    const prepared: PreparedPackage[] = [];
    const plugins: CollectionPluginFacts[] = [];
    const worlds: CollectionWorldFacts[] = [];
    for (const [kind, members] of [
      ["plugin", manifest.plugins],
      ["world", manifest.worlds],
    ] as const)
      for (const member of members) {
        if ("repository" in member)
          throw httpError(
            400,
            `A collection ZIP must contain every member; ${member.repository} is pinned in another repository`,
          );
        const bundle = selectPackageEntries(entries, member.path);
        if (kind === "world") {
          const denied = checkWorldWriteAccess(c);
          if (denied) return denied;
          const { id } = await inspectWorldBundle(bundle);
          worlds.push(worldFacts(bundle));
          prepared.push({ kind, id, entries: bundle });
        } else {
          const { pluginId } = validatePluginBundle(bundle, reserved);
          plugins.push(pluginFacts(bundle));
          prepared.push({ kind, id: pluginId, entries: bundle });
        }
      }
    const errors = checkCollection({
      worlds,
      plugins,
      available: availablePlugins(c),
      hostVersion: APP_VERSION,
      collectionRange: manifest.covel,
    }).filter((problem) => problem.level === "error");
    if (errors.length > 0)
      throw httpError(400, errors.map((item) => item.message).join(" "));
    return c.json(await installPrepared(c, prepared), 201);
  } catch (error) {
    const { status, body } = errorResponse(error);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});
