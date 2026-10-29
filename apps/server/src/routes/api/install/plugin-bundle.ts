import path from "node:path";
import { z } from "zod";
import { pluginIdSchema } from "@covel/shared";
import {
  missingDefaultHandler,
  packageModuleTypeProblem,
  pluginImportReferences,
  type ParsedPluginMd,
  readPlainYamlFrontmatter,
  runtimeDirectoryDiagnostics,
  parsePluginMd,
  validatePluginFiles,
  compileInlineRuntime,
  parseRuntimeMd,
  validatePluginDeclarations,
  multiRuntimeRootDiagnostics,
  withDerivedPackageFields,
  type ParsedRuntimeMd,
} from "@covel/plugin-loader";
import { assertHostVersionInRange } from "../../../lib/app-version.js";
import {
  assertNoReservedInstallFiles,
  httpError,
  type ExtractedEntry,
} from "./shared.js";

/** Installation reports parsing errors as invalid package input. */
export function readPluginFrontmatter(
  content: string,
): Record<string, unknown> {
  try {
    return readPlainYamlFrontmatter(content).data;
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface PluginManifestSummary {
  readonly pluginId: string;
  /** The root manifest with its derived entry, contracts and tags. */
  readonly manifest: ParsedPluginMd;
  /** The `version` of PLUGIN.md. */
  readonly version: string | null;
  readonly hasServerCode: boolean;
}

/** What installation reads from an optional `package.json`. */
const installPackageSchema = z.object({
  name: z.unknown().optional(),
  type: z.unknown().optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
});
type InstallPackage = z.infer<typeof installPackageSchema>;

/** All install paths require a self-contained release; development tools are allowed. */
function validateRuntimeDependencies(pkg: InstallPackage): void {
  const declared = (
    ["dependencies", "optionalDependencies", "peerDependencies"] as const
  ).filter((field) => Object.keys(pkg[field] ?? {}).length > 0);
  if (declared.length)
    throw new Error(
      `package.json declares runtime dependencies in ${declared.join(", ")}. Bundle the runtime dependencies into self-contained release files and remove these declarations (or leave empty maps); devDependencies are allowed. The installer never runs package managers or build scripts.`,
    );
}

/** The package's `package.json`, when it has one. */
function readPackageJson(
  entries: readonly ExtractedEntry[],
): InstallPackage | undefined {
  const entry = entries.find((e) => e.relativePath === "package.json");
  if (!entry) return undefined;
  try {
    return installPackageSchema.parse(
      JSON.parse(entry.content.toString("utf-8")),
    );
  } catch (error) {
    throw httpError(
      400,
      `package.json is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The plugin ID an npm package name suggests: the Covel convention names the
 * package `@covel/plugin-<id>`, so the scope and a single exact `plugin-`
 * prefix are dropped.
 */
function idFromPackageName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const base = name.trim().split("/").at(-1) ?? "";
  return base.startsWith("plugin-") ? base.slice("plugin-".length) : base;
}

function validPluginId(id: string): boolean {
  return id.length <= 64 && pluginIdSchema.safeParse(id).success;
}

/**
 * The ID a package installs under. A written `id` is the ID. Without one it
 * is the name of the directory that held the package (the top-level
 * directory of the archive, the directory of a repository, or the repository
 * itself), and without a usable directory name the `package.json` name.
 */
export function installPluginId(
  frontmatter: Readonly<Record<string, unknown>>,
  directory: string | undefined,
  packageJson: InstallPackage | undefined,
): string {
  if (frontmatter.id !== undefined) {
    const written = String(frontmatter.id);
    if (!validPluginId(written))
      throw httpError(400, `invalid plugin id in PLUGIN.md: ${written}`);
    return written;
  }
  const candidates = [directory, idFromPackageName(packageJson?.name)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const id = candidates.find(validPluginId);
  if (id) return id;
  throw httpError(
    400,
    candidates.length
      ? `PLUGIN.md writes no id, and neither ${candidates.map((c) => `"${c}"`).join(" nor ")} is a plugin ID (lowercase letters, digits and hyphens); write id in PLUGIN.md`
      : "PLUGIN.md writes no id, and the package has no directory or package.json name to take it from; write id in PLUGIN.md",
  );
}

/** macOS archives keep resource forks here; they are not package files. */
const MACOS_METADATA = "__MACOSX/";

/**
 * An archive of the package directory holds the files under that directory.
 * Its name stands in for an `id` the package does not write, and its files
 * install as the package root. An archive with a root PLUGIN.md is the
 * package root itself.
 */
export function unwrapPackageDirectory(entries: readonly ExtractedEntry[]): {
  readonly entries: readonly ExtractedEntry[];
  readonly directory?: string;
} {
  if (entries.some((entry) => entry.relativePath === "PLUGIN.md"))
    return { entries };
  const files = entries.filter(
    (entry) => !entry.relativePath.startsWith(MACOS_METADATA),
  );
  const roots = new Set(files.map((entry) => entry.relativePath.split("/")[0]));
  const [directory] = roots;
  if (
    roots.size !== 1 ||
    !directory ||
    !files.some((entry) => entry.relativePath === `${directory}/PLUGIN.md`)
  )
    return { entries };
  return {
    directory,
    entries: files.map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.slice(directory.length + 1),
    })),
  };
}

export function validatePluginBundle(
  entries: readonly ExtractedEntry[],
  reservedPluginIds: ReadonlySet<string>,
  /** Name of the directory that held the package, when there was one. */
  directory?: string,
): PluginManifestSummary {
  assertNoReservedInstallFiles(entries);
  // Validate translations too: discovery can select a localized manifest
  // before session execution approval. Do not let one smuggle a JS engine.
  for (const entry of entries) {
    if (
      /^(?:PLUGIN(?:\.[a-zA-Z0-9-]+)?|runtimes\/[^/]+\/(?:PLUGIN|RUNTIME)(?:\.[a-zA-Z0-9-]+)?)\.md$/.test(
        entry.relativePath,
      )
    )
      readPluginFrontmatter(entry.content.toString("utf8"));
  }
  const manifestEntry = entries.find(
    (entry) => entry.relativePath === "PLUGIN.md",
  );
  if (!manifestEntry) {
    throw httpError(
      400,
      "no root PLUGIN.md found; every plugin requires a root declaration",
    );
  }
  const packageJson = readPackageJson(entries);

  // One identity: the runtime, store, proposals, hooks and trust checks all
  // key on the root manifest id, so the reserved-ID check, the install
  // directory and the API response use it too.
  const pluginId = installPluginId(
    readPluginFrontmatter(manifestEntry.content.toString("utf8")),
    directory,
    packageJson,
  );
  if (
    [...reservedPluginIds].some(
      (id) => id.toLowerCase() === pluginId.toLowerCase(),
    )
  ) {
    throw httpError(
      409,
      `plugin id "${pluginId}" is reserved for a builtin plugin`,
    );
  }

  const runtimeFiles = new Map<string, string[]>();
  for (const entry of entries) {
    const match = /^runtimes\/([^/]+)\/(.+)$/.exec(entry.relativePath);
    const runtimeDirectory = match?.[1];
    const file = match?.[2];
    if (!runtimeDirectory || !file) continue;
    const files = runtimeFiles.get(runtimeDirectory) ?? [];
    files.push(file);
    runtimeFiles.set(runtimeDirectory, files);
  }
  for (const [runtimeDirectory, files] of runtimeFiles) {
    const diagnostic = runtimeDirectoryDiagnostics(
      `runtimes/${runtimeDirectory}`,
      files,
    );
    const problem = diagnostic.error ?? diagnostic.warning;
    if (problem) throw httpError(400, problem);
  }
  const children = entries.filter((entry) =>
    /^runtimes\/[^/]+\/RUNTIME\.md$/.test(entry.relativePath),
  );
  const exists = (relativePath: string) =>
    entries.some((entry) => entry.relativePath === relativePath);
  try {
    // The package installs into a directory named after its ID, so a
    // manifest without `id` takes that name.
    const parsed = parsePluginMd(
      manifestEntry.content.toString("utf8"),
      `${pluginId}/PLUGIN.md`,
    );
    // Refuse a package written for another host before any file is written.
    assertHostVersionInRange(`Plugin ${pluginId}`, parsed.plugin.covel);
    if (entries.some((entry) => entry.relativePath.startsWith("runtimes/"))) {
      const diagnostics = multiRuntimeRootDiagnostics(parsed.rawFrontmatter);
      if (diagnostics.length)
        throw new Error(diagnostics.map((d) => d.message).join("\n"));
    }
    const inline = compileInlineRuntime(parsed);
    const declarations: ParsedRuntimeMd[] = inline ? [inline] : [];
    for (const child of children)
      declarations.push(
        parseRuntimeMd(
          child.content.toString("utf8"),
          `${pluginId}/${child.relativePath}`,
          parsed.plugin,
        ),
      );
    for (const declaration of declarations) {
      const disabled = missingDefaultHandler(pluginId, declaration, exists);
      if (disabled) throw new Error(disabled.message);
    }
    const root = withDerivedPackageFields(parsed, declarations, exists);
    validatePluginDeclarations(root);
    validatePluginFiles(
      root,
      declarations,
      (absolutePath) => {
        const relative = path
          .relative(path.resolve(pluginId), absolutePath)
          .split(path.sep)
          .join("/");
        const entry = entries.find(
          (candidate) => candidate.relativePath === relative,
        );
        if (!entry) throw new Error("File not found");
        return entry.content.toString("utf8");
      },
      (absoluteDir) =>
        entries.flatMap((entry) => {
          const file = path.resolve(pluginId, entry.relativePath);
          const relative = path.relative(absoluteDir, file);
          return relative &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
            ? [{ path: file, size: entry.content.byteLength }]
            : [];
        }),
    );
    // `package.json` is optional: a package without one is ESM and bundles
    // no dependencies.
    if (packageJson) {
      validateRuntimeDependencies(packageJson);
      const moduleProblem = packageModuleTypeProblem(packageJson);
      if (moduleProblem) throw new Error(moduleProblem);
    }
    // Localizations may change presentation only; identity and code declarations
    // are reconciled against the canonical document before installation.
    for (const entry of entries) {
      if (/^PLUGIN\.[a-zA-Z0-9-]+\.md$/.test(entry.relativePath)) {
        parsePluginMd(
          entry.content.toString("utf8"),
          `${pluginId}/${entry.relativePath}`,
          root.rawFrontmatter,
        );
      } else if (
        /^runtimes\/[^/]+\/RUNTIME\.[a-zA-Z0-9-]+\.md$/.test(entry.relativePath)
      ) {
        const canonicalPath = entry.relativePath.replace(
          /RUNTIME\.[^.]+\.md$/,
          "RUNTIME.md",
        );
        const canonical = declarations.find(
          (record) => record.sourcePath === `${pluginId}/${canonicalPath}`,
        );
        if (!canonical)
          throw new Error(
            `Localized runtime has no canonical RUNTIME.md: ${entry.relativePath}`,
          );
        parseRuntimeMd(
          entry.content.toString("utf8"),
          `${pluginId}/${entry.relativePath}`,
          root.plugin,
          canonical.rawFrontmatter,
        );
      }
    }
    return {
      pluginId,
      manifest: root,
      version: root.plugin.version ?? null,
      // The resolved entry counts: `server/index.js` is the entry of a
      // package that names none.
      hasServerCode:
        pluginImportReferences(root, declarations).length > 0 ||
        entries.some((entry) =>
          /\.(?:[cm]?[jt]s|tsx|node|wasm)$/i.test(entry.relativePath),
        ),
    };
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}
