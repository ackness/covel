/**
 * Package fields the loader works out instead of asking the author: the entry
 * module when `server/index.js` exists, the contracts the runtimes output,
 * and the `ui:*` / `cost:*` catalogue tags. Loading, `validate:plugin` and
 * installation apply the same rules, each with its own way to look for a
 * file.
 */
import path from "node:path";
import { DEFAULT_FUNCTION_HANDLER, DEFAULT_PLUGIN_ENTRY } from "@covel/shared";
import type { PluginManifest } from "@covel/shared";
import { normalizePackageManifest } from "./parse-plugin-md.js";
import type {
  DisabledRuntime,
  ParsedPluginMd,
  ParsedRuntimeMd,
} from "./types.js";

/** Whether a file exists at this path relative to the package root. */
export type PackageFileExists = (relativePath: string) => boolean;

/** Tags the loader derives; a written one is ignored. */
export function isDerivedTag(tag: string): boolean {
  return tag.startsWith("ui:") || tag.startsWith("cost:");
}

type Provided = NonNullable<PluginManifest["provides"]>[number];
const contractOf = (entry: Provided) =>
  typeof entry === "string" ? entry : entry.contract;

/**
 * The contracts a package provides: the ones it writes, then the output
 * contract of each runtime it does not write. A written entry stays as it
 * is, so `{ contract, default: true }` still marks the default provider.
 */
export function packageProvides(
  plugin: PluginManifest,
  runtimes: readonly ParsedRuntimeMd[],
): Provided[] {
  const provides: Provided[] = [...(plugin.provides ?? [])];
  const listed = new Set(provides.map(contractOf));
  for (const { manifest } of runtimes) {
    const contract = manifest.outputContract;
    if (!contract || listed.has(contract)) continue;
    listed.add(contract);
    provides.push(contract);
  }
  return provides;
}

/**
 * The catalogue tags: the written ones the loader cannot derive, then
 * `cost:llm` when a runtime calls a model, `cost:function` when one runs code
 * without a model (or, with no runtime, the package runs an entry module or a
 * world projection handler),
 * `ui:right-panel` / `ui:message-block` for declared panels and
 * `ui:manual-action` for something the player starts (a manual runtime, an
 * action or a command). A written tag comes first: the session-prep screen
 * shows the first tags on a plugin's row and groups a plugin with no
 * `cost:*` tag under its first one. `plugin.entry` is the resolved entry, the
 * default included.
 */
export function packageTags(
  plugin: PluginManifest,
  runtimes: readonly ParsedRuntimeMd[],
): string[] {
  const tags = (plugin.tags ?? []).filter((tag) => !isDerivedTag(tag));
  const contributes = plugin.contributes;
  const manifests = runtimes.map(({ manifest }) => manifest);
  const derived: [string, boolean][] = [
    [
      "cost:llm",
      manifests.some(
        (manifest) =>
          manifest.runtimeType !== "function" || manifest.model !== undefined,
      ),
    ],
    [
      "cost:function",
      manifests.some(
        (manifest) =>
          manifest.runtimeType === "function" && manifest.model === undefined,
      ) ||
        (manifests.length === 0 &&
          (plugin.entry !== undefined ||
            Object.keys(contributes?.worldProjections ?? {}).length > 0)),
    ],
    ["ui:right-panel", Boolean(contributes?.ui?.right?.length)],
    ["ui:message-block", Boolean(contributes?.ui?.message?.length)],
    [
      "ui:manual-action",
      manifests.some((manifest) => manifest.trigger?.type === "manual") ||
        Boolean(contributes?.actions?.length || contributes?.commands?.length),
    ],
  ];
  for (const [tag, applies] of derived)
    if (applies && !tags.includes(tag)) tags.push(tag);
  return tags;
}

/** The package with its derived entry, contracts and tags filled in. */
export function withDerivedPackageFields(
  parsed: ParsedPluginMd,
  runtimes: readonly ParsedRuntimeMd[],
  exists: PackageFileExists,
): ParsedPluginMd {
  const {
    entry: _entry,
    provides: _provides,
    tags: _tags,
    ...rest
  } = parsed.plugin;
  const entry =
    parsed.plugin.entry ??
    (exists(DEFAULT_PLUGIN_ENTRY) ? DEFAULT_PLUGIN_ENTRY : undefined);
  const provides = packageProvides(parsed.plugin, runtimes);
  const tags = packageTags({ ...parsed.plugin, entry }, runtimes);
  const plugin: PluginManifest = {
    ...rest,
    ...(entry ? { entry } : {}),
    ...(provides.length ? { provides } : {}),
    ...(tags.length ? { tags } : {}),
  };
  return { ...parsed, plugin, manifest: normalizePackageManifest(plugin) };
}

/**
 * A function runtime that writes no `function.handler` uses `handler.js`
 * next to its manifest. Without that file it cannot run: the runtime is
 * left out with this reason, and the rest of the package loads.
 */
export function missingDefaultHandler(
  rootPath: string,
  parsed: ParsedRuntimeMd,
  exists: PackageFileExists,
): DisabledRuntime | undefined {
  if (!parsed.runtime.function || parsed.runtime.function.handler)
    return undefined;
  const source = parsed.sourcePath ?? path.join(rootPath, "PLUGIN.md");
  const handler = path
    .relative(
      rootPath,
      path.resolve(path.dirname(source), DEFAULT_FUNCTION_HANDLER),
    )
    .split(path.sep)
    .join("/");
  if (exists(handler)) return undefined;
  const field =
    parsed.manifest.name === parsed.manifest.pluginId
      ? "runtime.function.handler"
      : "function.handler";
  return {
    sourcePath: source,
    message: `${source}: ${field}: not written, and there is no ${DEFAULT_FUNCTION_HANDLER} next to this file; add the handler module there or write its path; the runtime does not run until this is fixed`,
    ...(parsed.manifest.outputContract
      ? { outputContract: parsed.manifest.outputContract }
      : {}),
  };
}
