import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WorldSections } from "@covel/create";
import {
  DEFAULT_LOCALE,
  resolveWorldDimensionsLocale,
  type WorldDimensions,
} from "@covel/shared";
import type { WorldRecord } from "@covel/store";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { sourceItems } from "./session-import/utils.js";
import { readWorldDataSource } from "./source-reader.js";
import { parseWorldDataTarget } from "./target-uri.js";

/**
 * A world as the three sections the world generator writes, so that a
 * revision can start from what the world is now.
 *
 * The manifest is rebuilt from the record with its data inline. The package
 * content comes from the package files when the world has a directory, and
 * from the record's metadata for a world that lives in a store or a browser.
 */

/** The `world.yaml` format version that the generator writes. */
const MANIFEST_VERSION = "1.0";

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface PackageContent {
  characters: Entry[];
  lorebook: Entry[];
  rules: Entry[];
  contractData: Entry[];
}

/** The generator marks each lorebook entry with the list it came from. */
function addLorebook(content: PackageContent, entries: readonly unknown[]) {
  for (const entry of entries) {
    if (!isEntry(entry)) continue;
    const kind = isEntry(entry.extra) ? entry.extra.sourceKind : undefined;
    (kind === "rule" ? content.rules : content.lorebook).push(entry);
  }
}

async function contentFromFiles(
  record: WorldRecord,
  worldRoot: string,
): Promise<PackageContent> {
  const content: PackageContent = {
    characters: [],
    lorebook: [],
    rules: [],
    contractData: [],
  };
  const worldDataPath = record.metadata?.worldDataPath;
  const { sources } = await loadWorldDataDescriptor({
    worldRoot,
    worldId: record.id,
    worldDataPath:
      typeof worldDataPath === "string" ? worldDataPath : undefined,
  });
  for (const source of sources) {
    const target = parseWorldDataTarget(source.descriptor.to);
    if (!target || target.kind === "media" || target.kind === "world-metadata")
      continue;
    const { value } = await readWorldDataSource(source);
    if (value === undefined) continue;
    const items = sourceItems(value).filter(isEntry);
    if (target.kind === "characters") content.characters.push(...items);
    else if (target.kind === "lorebook") addLorebook(content, items);
    else
      for (const item of items)
        if (typeof item.id === "string")
          content.contractData.push({
            contract: target.contract,
            key: item.id,
            value: item,
          });
  }
  return content;
}

function contentFromRecord(record: WorldRecord): PackageContent {
  const metadata = record.metadata ?? {};
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter(isEntry) : [];
  const content: PackageContent = {
    characters: list(
      metadata.characterBlueprints ?? metadata.embeddedCharacters,
    ),
    lorebook: [],
    rules: [],
    contractData: list(metadata.contractData).map(
      ({ contract, key, value }) => ({ contract, key, value }),
    ),
  };
  addLorebook(content, list(metadata.embeddedLorebook));
  return content;
}

/** `world.yaml` of the record, with the dimensions inline and one language. */
function manifestOf(record: WorldRecord): Entry {
  const metadata = record.metadata ?? {};
  const locale = record.locale ?? DEFAULT_LOCALE;
  const dimensions = (record.dimensions ?? metadata.dimensions) as
    WorldDimensions | undefined;
  const keep = (key: string) =>
    metadata[key] === undefined || metadata[key] === null
      ? {}
      : { [key]: metadata[key] };
  return {
    schemaVersion: MANIFEST_VERSION,
    id: record.id,
    name: record.name,
    summary: record.description,
    defaultLocale: locale,
    ...(record.tags?.length ? { tags: record.tags } : {}),
    ...keep("pluginPolicy"),
    ...keep("pluginSettings"),
    ...keep("characterSchema"),
    ...keep("defaultViewMode"),
    ...(dimensions && Object.keys(dimensions).length
      ? // A translated world holds every language; a revision works on one.
        { dimensions: resolveWorldDimensionsLocale(dimensions, locale) }
      : {}),
  };
}

/**
 * The manifest of a package: `world.yaml` as its author wrote it, so that
 * fields the record does not keep (`version`) survive a revision. The data
 * is put inline, and the editions go back to the world's own language: a
 * revision replaces the package, and its locale files with it.
 */
async function manifestOfPackage(
  record: WorldRecord,
  worldRoot: string,
): Promise<Entry> {
  const fromRecord = manifestOf(record);
  let written: unknown;
  try {
    written = parseYaml(
      await readFile(path.join(worldRoot, "world.yaml"), "utf-8"),
    );
  } catch {
    return fromRecord;
  }
  if (!isEntry(written)) return fromRecord;
  const {
    worldData: _worldData,
    dimensionSources: _dimensionSources,
    supportedLocales: _supportedLocales,
    dimensions: _dimensions,
    ...manifest
  } = written;
  return {
    ...manifest,
    // A package that lists its editions keeps the list, with one edition.
    ...(_supportedLocales === undefined
      ? {}
      : { supportedLocales: [fromRecord.defaultLocale] }),
    ...(fromRecord.dimensions ? { dimensions: fromRecord.dimensions } : {}),
  };
}

export async function worldSectionsOf(
  record: WorldRecord,
  /** The package directory, for a world that has one. */
  worldRoot?: string,
): Promise<WorldSections> {
  const content = worldRoot
    ? await contentFromFiles(record, worldRoot)
    : contentFromRecord(record);
  const manifest = worldRoot
    ? await manifestOfPackage(record, worldRoot)
    : manifestOf(record);
  const filled = Object.fromEntries(
    Object.entries(content).filter(([, items]) => items.length > 0),
  );
  return {
    yaml: stringifyYaml(manifest, { lineWidth: 0 }),
    lore: record.lore ?? "",
    ...(Object.keys(filled).length
      ? { packageYaml: stringifyYaml(filled, { lineWidth: 0 }) }
      : {}),
  };
}
