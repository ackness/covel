/**
 * Static validation of one world package directory.
 *
 * Runs the same world-data preflight that session creation runs, against a
 * plugin catalogue discovered from plugin directories, so an author learns
 * about a bad seed record or a mistyped plugin ID before starting a session.
 * Nothing is written and no plugin code is executed.
 */

import { readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { createEventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  DEFAULT_LOCALE,
  applyLocaleOverlay,
  findInlineLocaleMaps,
  validateWorldManifest,
} from "@covel/shared";
import { discoverAndRegisterPlugins } from "../routes/api/bootstrap/plugin-discovery.js";
import { resolveLocaleFilePath } from "../world-seed-loader.js";
import {
  conventionsOfPlugins,
  setWorldDataConventions,
  worldDataConventions,
  worldHasData,
} from "./conventions.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import {
  findLocaleOverlays,
  readWorldManifestSource,
  type LocaleOverlayFileIssue,
} from "./locale-overlays.js";
import { worldTranslationStatus } from "./locale-tooling.js";
import { preflightWorldDataForSession } from "./session-import.js";
import { fileExists } from "./session-import/utils.js";
import { readWorldDataSource } from "./source-reader.js";
import { resolveWorldThemeMusic } from "./gallery.js";
import { parseWorldDataTarget } from "./target-uri.js";
import type { OrderedWorldDataSource } from "./types.js";
import { loadWorldDataSummary } from "./world-load.js";

export interface WorldPackageDiagnostic {
  readonly level: "error" | "warning";
  /** Stable machine code, so callers can group or filter. */
  readonly code:
    | "manifest-invalid"
    | "lore-missing"
    | "lore-fallback-missing"
    | "unknown-plugin"
    | "unknown-setting"
    | "unprovided-contract"
    | "unresolved-contract"
    | "world-data"
    | "locale-overlay"
    | "locale-script"
    | "edition-incomplete"
    | "data-file-unused"
    | "inline-locale-map"
    | "theme-music";
  /** Path relative to the world directory. */
  readonly file?: string;
  /** Location inside `file`, such as `pluginPolicy.requested[1]`. */
  readonly pointer?: string;
  readonly sourceId?: string;
  readonly locales?: readonly string[];
  readonly message: string;
  /** What the author can do about it. */
  readonly hint?: string;
}

export interface ValidateWorldPackageOptions {
  readonly worldDir: string;
  /** Directories scanned for plugin packages; the catalogue IDs are checked against. */
  readonly pluginsDirs: readonly string[];
  /**
   * Treat a plugin ID or contract that no scanned plugin supplies as an error.
   * Without it they are warnings, because the supplier may be a community
   * plugin that is not in `pluginsDirs`.
   */
  readonly strict?: boolean;
}

export interface ValidateWorldPackageResult {
  readonly worldId?: string;
  readonly diagnostics: readonly WorldPackageDiagnostic[];
}

type PluginCatalogue = Pick<PluginRegistry, "get" | "getAll">;
type CatalogueEntry = NonNullable<ReturnType<PluginRegistry["get"]>>;

interface WorldManifestView {
  readonly id: string;
  readonly defaultLocale: string;
  readonly supportedLocales?: readonly string[];
  readonly worldData?: string;
  readonly themeMusic?: string;
  readonly pluginPolicy?: {
    readonly requested?: readonly string[];
    readonly recommended?: readonly string[];
    readonly requires?: readonly string[];
    readonly packs?: readonly {
      readonly requested?: readonly string[];
      readonly recommended?: readonly string[];
    }[];
  };
  readonly pluginSettings?: Readonly<Record<string, Record<string, unknown>>>;
}

/** No user override lives here, so a package is validated as shipped. */
const NO_OVERRIDES_HOME = path.join(tmpdir(), "covel-validate-no-overrides");

export async function loadPluginCatalogue(
  pluginsDirs: readonly string[],
): Promise<PluginCatalogue> {
  const merged = new Map<string, CatalogueEntry>();
  // One discovery per directory: scanning them together would treat every
  // directory after the first as an install target and apply pending updates.
  for (const pluginsDir of pluginsDirs) {
    const { registry } = await discoverAndRegisterPlugins({
      pluginsDir,
      eventBus: createEventBus(),
    });
    for (const [id, entry] of registry.getAll())
      if (!merged.has(id)) merged.set(id, entry);
  }
  return { get: (id) => merged.get(id), getAll: () => merged };
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** The closest known name, when it is close enough to be a likely typo. */
function closestName(
  name: string,
  known: Iterable<string>,
): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(name, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  const limit = Math.max(1, Math.floor(name.length / 4));
  return best && best.distance <= limit ? best.name : undefined;
}

function declaredLocales(manifest: WorldManifestView): readonly string[] {
  return [
    ...new Set([manifest.defaultLocale, ...(manifest.supportedLocales ?? [])]),
  ];
}

/**
 * A declared locale is a promise: a player who asks for it gets a session in
 * it. Texts the edition does not translate reach that session in the world's
 * own language, beside instructions that ask for the declared one.
 */
async function checkEditions(
  worldDir: string,
  manifest: WorldManifestView,
): Promise<WorldPackageDiagnostic[]> {
  const diagnostics: WorldPackageDiagnostic[] = [];
  for (const locale of manifest.supportedLocales ?? []) {
    if (locale === manifest.defaultLocale) continue;
    let status: Awaited<ReturnType<typeof worldTranslationStatus>>;
    try {
      status = await worldTranslationStatus(worldDir, locale);
    } catch {
      continue; // A source that cannot be read is reported by the data check.
    }
    const total = status.files.reduce((sum, file) => sum + file.total, 0);
    const missing = status.files.filter((file) => file.missing.length > 0);
    const count = missing.reduce((sum, file) => sum + file.missing.length, 0);
    if (count === 0) continue;
    diagnostics.push({
      level: "warning",
      code: "edition-incomplete",
      file: missing[0]!.file,
      locales: [locale],
      message: `the ${locale} edition lacks ${count} of ${total} texts (${missing
        .slice(0, 3)
        .map((file) => `${file.file}: ${file.missing.length}`)
        .join(
          ", ",
        )}); a ${locale} session reads them in ${manifest.defaultLocale}`,
      hint: `Run \`pnpm i18n status ${path.basename(worldDir)} --locale ${locale} --missing\` to list them and \`pnpm i18n translate\` to fill them, or remove ${locale} from supportedLocales.`,
    });
  }
  return diagnostics;
}

/** The world list plays `themeMusic` only when it can serve the file. */
async function checkThemeMusic(
  worldDir: string,
  manifest: WorldManifestView,
): Promise<WorldPackageDiagnostic[]> {
  if (!manifest.themeMusic) return [];
  if (await resolveWorldThemeMusic({ worldRoot: worldDir })) return [];
  return [
    {
      level: "error",
      code: "theme-music",
      file: manifest.themeMusic,
      message: `\`themeMusic\` names "${manifest.themeMusic}", which the world list cannot play`,
      hint: "Name an existing `.mp3` or `.wav` file one directory under `media/`, such as `media/music/theme.mp3`, of at most 20 MB.",
    },
  ];
}

async function checkLore(
  worldDir: string,
  manifest: WorldManifestView,
): Promise<WorldPackageDiagnostic[]> {
  const diagnostics: WorldPackageDiagnostic[] = [];
  const locales = declaredLocales(manifest);
  const missing: string[] = [];
  for (const locale of locales)
    if (!(await resolveLocaleFilePath(worldDir, "WORLD.md", locale)))
      missing.push(locale);
  if (missing.length > 0)
    diagnostics.push({
      level: "error",
      code: "lore-missing",
      file: "WORLD.md",
      locales: missing,
      message: `no lore file for declared locale ${missing.join(", ")}; those sessions start with empty lore`,
      hint: "Add `WORLD.md`, or a `WORLD.<locale>.md` for each declared locale.",
    });
  else if (!(await fileExists(path.join(worldDir, "WORLD.md"))))
    diagnostics.push({
      level: "warning",
      code: "lore-fallback-missing",
      file: "WORLD.md",
      message: `\`WORLD.md\` is missing; a session in any locale other than ${locales.join(", ")} starts with empty lore`,
      hint: "Rename the default-locale lore file to `WORLD.md`; it is the fallback for every locale.",
    });
  return diagnostics;
}

function checkPluginReferences(
  manifest: WorldManifestView,
  catalogue: PluginCatalogue,
  strict: boolean,
): WorldPackageDiagnostic[] {
  const diagnostics: WorldPackageDiagnostic[] = [];
  const known = [...catalogue.getAll().keys()];
  const references: { id: string; pointer: string }[] = [];
  const collect = (ids: readonly string[] | undefined, pointer: string) =>
    ids?.forEach((id, index) =>
      references.push({ id, pointer: `${pointer}[${index}]` }),
    );
  collect(manifest.pluginPolicy?.requested, "pluginPolicy.requested");
  collect(manifest.pluginPolicy?.recommended, "pluginPolicy.recommended");
  manifest.pluginPolicy?.packs?.forEach((pack, index) => {
    collect(pack.requested, `pluginPolicy.packs[${index}].requested`);
    collect(pack.recommended, `pluginPolicy.packs[${index}].recommended`);
  });
  for (const id of Object.keys(manifest.pluginSettings ?? {}))
    references.push({ id, pointer: `pluginSettings.${id}` });

  for (const { id, pointer } of references) {
    if (catalogue.get(id)) continue;
    const suggestion = closestName(id, known);
    diagnostics.push({
      // A near miss is a typo. Otherwise the plugin may simply live outside
      // the scanned directories.
      level: suggestion || strict ? "error" : "warning",
      code: "unknown-plugin",
      file: "world.yaml",
      pointer,
      message: `plugin "${id}" is not in the scanned plugin directories`,
      hint: suggestion
        ? `Did you mean "${suggestion}"?`
        : "A session lists it as missing. Pass its directory with `--plugins` when it is a community plugin.",
    });
  }

  for (const [pluginId, settings] of Object.entries(
    manifest.pluginSettings ?? {},
  )) {
    const declared = (
      catalogue.get(pluginId)?.packageManifest?.plugin?.contributes?.settings ??
      []
    ).map((setting) => setting.key);
    if (!catalogue.get(pluginId)) continue;
    for (const key of Object.keys(settings)) {
      if (declared.includes(key)) continue;
      const suggestion = closestName(key, declared);
      diagnostics.push({
        level: "warning",
        code: "unknown-setting",
        file: "world.yaml",
        pointer: `pluginSettings.${pluginId}.${key}`,
        message: `plugin "${pluginId}" declares no setting "${key}"; the value is ignored`,
        hint: suggestion
          ? `Did you mean "${suggestion}"?`
          : declared.length > 0
            ? `Declared settings: ${declared.join(", ")}.`
            : "This plugin declares no settings.",
      });
    }
  }

  const provided = new Set<string>();
  for (const [, entry] of catalogue.getAll())
    for (const provision of entry.packageManifest?.plugin?.provides ?? [])
      provided.add(
        typeof provision === "string" ? provision : provision.contract,
      );
  manifest.pluginPolicy?.requires?.forEach((contract, index) => {
    if (provided.has(contract)) return;
    const suggestion = closestName(contract, provided);
    diagnostics.push({
      level: suggestion || strict ? "error" : "warning",
      code: "unprovided-contract",
      file: "world.yaml",
      pointer: `pluginPolicy.requires[${index}]`,
      message: `no scanned plugin provides contract "${contract}"; session creation fails without a provider`,
      hint: suggestion ? `Did you mean "${suggestion}"?` : undefined,
    });
  });
  return diagnostics;
}

/** Data contracts a scanned plugin accepts world data for, or publishes a schema for. */
function knownDataContracts(catalogue: PluginCatalogue): Set<string> {
  const contracts = new Set<string>();
  for (const [, entry] of catalogue.getAll()) {
    const plugin = entry.packageManifest?.plugin;
    for (const contract of Object.keys(plugin?.contracts ?? {}))
      contracts.add(contract);
    for (const declaration of Object.values(plugin?.contributes?.data ?? {}))
      for (const contract of declaration.accepts ?? []) contracts.add(contract);
  }
  return contracts;
}

function sourceContracts(source: OrderedWorldDataSource): string[] {
  const contracts: string[] = [];
  for (const uri of [source.descriptor.to, source.descriptor.indexTo]) {
    const target = uri ? parseWorldDataTarget(uri) : null;
    if (target?.kind === "contract-data") contracts.push(target.contract);
  }
  if (source.descriptor.schema?.startsWith("contract:"))
    contracts.push(source.descriptor.schema.slice("contract:".length));
  return [...new Set(contracts)];
}

function listSome(values: readonly string[]): string {
  const shown = values.slice(0, 5).join(", ");
  return values.length > 5 ? `${shown} and ${values.length - 5} more` : shown;
}

/** An authored file holds one language; its translations are overlay files. */
function inlineLocaleMapDiagnostics(
  file: string,
  value: unknown,
  defaultLocale: string | undefined,
  sourceId?: string,
): WorldPackageDiagnostic[] {
  const found = findInlineLocaleMaps(value, defaultLocale ?? DEFAULT_LOCALE);
  if (found.length === 0) return [];
  const parsed = path.parse(file);
  return [
    {
      level: "error",
      code: "inline-locale-map",
      file,
      ...(sourceId ? { sourceId } : {}),
      pointer: found[0]!.path,
      message: `${found.length} text${found.length === 1 ? " is" : "s are"} written as a locale map, at ${listSome(found.map((item) => item.path))}`,
      hint: `Write one language here and put each translation in \`${parsed.name}.<locale>${parsed.ext}\`, with the same keys and ids.`,
    },
  ];
}

function overlayDiagnostics(
  issues: readonly LocaleOverlayFileIssue[],
  sourceId?: string,
): WorldPackageDiagnostic[] {
  return issues.map((issue) => ({
    level: "warning" as const,
    code: "locale-overlay" as const,
    file: issue.file,
    ...(sourceId ? { sourceId } : {}),
    pointer: issue.path,
    message: `${issue.path} ${issue.message}; this translation is ignored`,
    hint: "A locale file may only translate text that the main file has, under the same keys and ids.",
  }));
}

const CJK_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** Paths of the text values that hold Chinese, Japanese or Korean characters. */
function cjkTextPaths(value: unknown, at = ""): string[] {
  if (typeof value === "string") return CJK_TEXT.test(value) ? [at] : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      cjkTextPaths(item, `${at}[${index}]`),
    );
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    cjkTextPaths(child, at ? `${at}.${key}` : key),
  );
}

/**
 * A locale file for a language written in another script should hold no
 * Chinese text. What is left is untranslated, or a trigger word copied from
 * the main file: a session in that language then shows it to the model.
 */
function localeScriptDiagnostics(
  file: string,
  locale: string,
  value: unknown,
  sourceId: string,
): WorldPackageDiagnostic[] {
  if (/^(zh|ja|ko)([-_]|$)/i.test(locale)) return [];
  const paths = cjkTextPaths(value);
  if (paths.length === 0) return [];
  return [
    {
      level: "warning",
      code: "locale-script",
      file,
      sourceId,
      pointer: paths[0],
      message: `${paths.length} text(s) in this ${locale} file hold Chinese, Japanese or Korean characters (${paths.slice(0, 3).join(", ")})`,
      hint: "A locale file holds text in its own language. Translate the text, or remove words that belong to another language.",
    },
  ];
}

/**
 * Locale files of structured sources: every overlay must apply cleanly, and
 * the main file must hold one language. Every overlay beside a source is
 * checked, not only those of the declared locales.
 */
async function checkLocaleFiles(
  worldDir: string,
  manifest: WorldManifestView,
  sources: readonly OrderedWorldDataSource[],
): Promise<WorldPackageDiagnostic[]> {
  const diagnostics: WorldPackageDiagnostic[] = [];
  for (const source of sources) {
    const { kind } = source.descriptor;
    if (
      source.inlineValue !== undefined ||
      (kind !== "json" && kind !== "yaml")
    )
      continue;
    const main = await readWorldDataSource(source);
    if (!main.path || main.value === undefined) continue;
    const file = path.relative(worldDir, main.path);
    diagnostics.push(
      ...inlineLocaleMapDiagnostics(
        file,
        main.value,
        manifest.defaultLocale,
        source.id,
      ),
    );
    for (const overlay of await findLocaleOverlays(
      source.pathOrigin.descriptorRoot,
      source.descriptor.path,
    )) {
      let parsed: unknown;
      try {
        const text = await readFile(overlay.path, "utf-8");
        parsed = kind === "json" ? JSON.parse(text) : parseYaml(text);
      } catch {
        continue; // The import preflight reports a file that does not parse.
      }
      diagnostics.push(
        ...localeScriptDiagnostics(
          path.relative(worldDir, overlay.path),
          overlay.locale,
          parsed,
          source.id,
        ),
      );
      diagnostics.push(
        ...overlayDiagnostics(
          applyLocaleOverlay(main.value, parsed, {
            mode: "resolve",
            locale: overlay.locale,
            baseLocale: manifest.defaultLocale ?? DEFAULT_LOCALE,
            arrayKey: source.descriptor.key,
          }).issues.map((issue) => ({
            ...issue,
            file: path.relative(worldDir, overlay.path),
          })),
          source.id,
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * In a package read by convention, a data file that no convention names is
 * not imported, and nothing else says so. With a descriptor every source is
 * written down, so this check is for the conventional case only.
 */
async function unclaimedDataFiles(
  worldDir: string,
): Promise<WorldPackageDiagnostic[]> {
  const claimed = new Set(
    worldDataConventions().map((source) => source.entry.path),
  );
  let names: string[];
  try {
    names = await readdir(path.join(worldDir, "data"));
  } catch {
    return [];
  }
  const diagnostics: WorldPackageDiagnostic[] = [];
  for (const name of names.sort()) {
    const file = `data/${name}`;
    if (!/\.(ya?ml|json)$/.test(name) || claimed.has(file)) continue;
    // `quests.zh-CN.yaml` translates `quests.yaml`; it is not a source.
    const base = name.replace(
      /\.[A-Za-z]{2,3}(-[A-Za-z0-9]+)*(\.[^.]+)$/,
      "$2",
    );
    if (base !== name && claimed.has(`data/${base}`)) continue;
    diagnostics.push({
      level: "warning",
      code: "data-file-unused",
      file,
      message:
        "this file is not imported: the package has no descriptor, and no scanned plugin names this path for its data",
      hint: `Paths that are read without a descriptor: ${[...claimed].sort().join(", ")}. For another path, list the file in a descriptor (\`worldData\` in world.yaml).`,
    });
  }
  return diagnostics;
}

async function checkWorldData(
  worldDir: string,
  manifest: WorldManifestView,
  catalogue: PluginCatalogue,
  strict: boolean,
): Promise<WorldPackageDiagnostic[]> {
  const diagnostics: WorldPackageDiagnostic[] = [];
  if (!manifest.worldData) {
    diagnostics.push(...(await unclaimedDataFiles(worldDir)));
    if (!(await worldHasData(worldDir, undefined))) return diagnostics;
  }
  // Where a problem of the descriptor itself is reported.
  const descriptorFile = manifest.worldData ?? "world.yaml";

  // The world-load pass covers the descriptor itself, source order, file
  // reads and non-contract schemas.
  const summary = await loadWorldDataSummary({
    worldRoot: worldDir,
    worldId: manifest.id,
    worldDataPath: manifest.worldData,
    covelHome: NO_OVERRIDES_HOME,
  });
  const descriptor = await loadWorldDataDescriptor({
    worldRoot: worldDir,
    worldId: manifest.id,
    worldDataPath: manifest.worldData,
  });
  const fileOf = new Map(
    descriptor.sources.map((source) => [source.id, source.descriptor.path]),
  );
  const loadErrors = summary.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  for (const diagnostic of loadErrors)
    diagnostics.push({
      level: "error",
      code: "world-data",
      file: diagnostic.sourceId
        ? (fileOf.get(diagnostic.sourceId) ?? descriptorFile)
        : descriptorFile,
      sourceId: diagnostic.sourceId,
      message: diagnostic.message,
    });
  if (loadErrors.length > 0) return diagnostics;

  // A contract nobody in the catalogue knows cannot be checked further. Report
  // it once, and drop the preflight's own errors for those sources.
  const known = knownDataContracts(catalogue);
  const unresolvedSources = new Set<string>();
  for (const source of descriptor.sources) {
    for (const contract of sourceContracts(source)) {
      if (known.has(contract)) continue;
      unresolvedSources.add(source.id);
      const suggestion = closestName(contract, known);
      diagnostics.push({
        level: suggestion || strict ? "error" : "warning",
        code: "unresolved-contract",
        file: descriptorFile,
        sourceId: source.id,
        message: `no scanned plugin accepts data contract "${contract}"; this source cannot be validated or imported`,
        hint: suggestion
          ? `Did you mean "${suggestion}"?`
          : "Pass the receiving plugin's directory with `--plugins`.",
      });
    }
  }

  // Each declared locale selects its own source variants, so validate each.
  const locales = declaredLocales(manifest);
  const seen = new Map<
    string,
    WorldPackageDiagnostic & { locales: string[] }
  >();
  for (const locale of locales) {
    const preflight = await preflightWorldDataForSession({
      sessionId: "validate-world",
      worldId: manifest.id,
      worldsDirs: [path.dirname(worldDir)],
      now: new Date(0).toISOString(),
      preflight: { registry: catalogue, executeProjectionHandlers: false },
      locale,
    }).catch((error: unknown) => ({
      diagnostics: [
        {
          level: "error" as const,
          message: error instanceof Error ? error.message : String(error),
          sourceId: undefined,
        },
      ],
    }));
    for (const diagnostic of preflight.diagnostics) {
      if (diagnostic.level === "info") continue;
      // Every locale file is checked once below, whatever locale reads it.
      if ("localeOverlay" in diagnostic && diagnostic.localeOverlay) continue;
      if (diagnostic.sourceId && unresolvedSources.has(diagnostic.sourceId))
        continue;
      const identity = `${diagnostic.level}\u0000${diagnostic.sourceId ?? ""}\u0000${diagnostic.message}`;
      const existing = seen.get(identity);
      if (existing) {
        existing.locales.push(locale);
        continue;
      }
      seen.set(identity, {
        level: diagnostic.level,
        code: "world-data",
        file: diagnostic.sourceId
          ? (fileOf.get(diagnostic.sourceId) ?? descriptorFile)
          : descriptorFile,
        sourceId: diagnostic.sourceId,
        locales: [locale],
        message: diagnostic.message,
      });
    }
  }
  for (const diagnostic of seen.values())
    diagnostics.push(
      // Naming the locales only helps when the finding is locale-specific.
      diagnostic.locales.length === locales.length
        ? { ...diagnostic, locales: undefined }
        : diagnostic,
    );

  diagnostics.push(
    ...(await checkLocaleFiles(worldDir, manifest, descriptor.sources)),
  );
  return diagnostics;
}

export async function validateWorldPackage(
  options: ValidateWorldPackageOptions,
): Promise<ValidateWorldPackageResult> {
  // Source readers report real paths; resolve symlinks once so every reported
  // file can be shown relative to the world directory.
  const worldDir = await realpath(options.worldDir).catch(() =>
    path.resolve(options.worldDir),
  );
  let raw: unknown;
  let source: Awaited<ReturnType<typeof readWorldManifestSource>>;
  try {
    source = await readWorldManifestSource(worldDir);
    raw = source.raw;
  } catch (error) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "manifest-invalid",
          file: "world.yaml",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const validation = validateWorldManifest(raw);
  if (!validation.valid)
    return {
      diagnostics: (validation.errors ?? []).map((issue) => ({
        level: "error" as const,
        code: "manifest-invalid" as const,
        file: "world.yaml",
        pointer: issue.path || undefined,
        message: issue.message,
      })),
    };

  const manifest = validation.data as WorldManifestView;
  const catalogue = await loadPluginCatalogue(options.pluginsDirs);
  // A package without a descriptor is read by the conventions of the
  // scanned plugins, as the server reads it by those of the installed ones.
  setWorldDataConventions(conventionsOfPlugins(catalogue));
  const strict = options.strict === true;
  return {
    worldId: manifest.id,
    diagnostics: [
      ...inlineLocaleMapDiagnostics(
        "world.yaml",
        source.base,
        manifest.defaultLocale,
      ),
      ...overlayDiagnostics(source.issues),
      ...(await checkLore(worldDir, manifest)),
      ...(await checkThemeMusic(worldDir, manifest)),
      ...(await checkEditions(worldDir, manifest)),
      ...checkPluginReferences(manifest, catalogue, strict),
      ...(await checkWorldData(worldDir, manifest, catalogue, strict)),
    ],
  };
}
