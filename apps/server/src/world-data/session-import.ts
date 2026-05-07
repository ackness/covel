import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
  CharacterRecord,
  DataStore,
  LorebookEntryRecord,
  MediaStore,
  PluginDataRecord,
  WorldDataImportLedgerRecord,
} from "@covel/store";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import { canonicalJson, digestFile, sha256Hex } from "./digest.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { collectMediaSourceFiles } from "./media.js";
import { readWorldDataSource } from "./source-reader.js";
import {
  characterBlueprintAdapter,
  characterMirrorTargets,
  characterRecordForCharacterEffect,
  characterRecordFromValue,
} from "./character-effects.js";
import {
  parsePluginSchemaUri,
  pluginSchemaUriForTarget,
  resolveWorldDataSchema,
  validateWorldDataSchemaValue,
  type WorldDataSchemaRef,
} from "./schema-registry.js";
import {
  parseWorldDataIndexTarget,
  parseWorldDataTarget,
  type ParsedWorldDataTarget,
} from "./target-uri.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

type PluginDataTarget = Extract<ParsedWorldDataTarget, { kind: "plugin-data" }>;

type PlannedWrite =
  | {
      readonly kind: "plugin-data";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "lorebook";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly id: string;
      readonly pluginId: string;
      readonly content: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "character";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly key: string;
      readonly record: CharacterRecord;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "media-index";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    };

type MergeEvent = {
  readonly level: "warning";
  readonly sourceId: string;
  readonly message: string;
};

interface ImportPlan {
  readonly writes: readonly PlannedWrite[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly mergeEvents: readonly MergeEvent[];
}

export interface WorldDataImportedMediaRef {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly cleanupOnFailure: boolean;
}

export interface WorldDataImportPreflightDeps {
  readonly activePlugins?: readonly string[];
  readonly registry?: Pick<PluginRegistry, "get">;
  readonly getPluginEntry?: (
    pluginId: string,
  ) => PluginRegistryEntry | undefined;
}

export interface ImportWorldDataForSessionResult {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly written: number;
  readonly skipped: number;
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}

export interface PreflightWorldDataForSessionResult {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly targets: readonly {
    readonly kind: PlannedWrite["kind"];
    readonly target: string;
    readonly sourceId: string;
    readonly pluginId?: string;
    readonly namespace?: string;
    readonly key?: string;
  }[];
}

export interface SyncWorldDataForSessionResult {
  readonly imported: boolean;
  readonly dryRun: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly conflicts: readonly {
    readonly target: string;
    readonly key?: string;
    readonly sourceId: string;
    readonly reason: "modified" | "missing";
  }[];
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

async function readWorldManifest(worldRoot: string): Promise<{
  id?: string;
  worldData?: string;
}> {
  const raw = parseYaml(
    await readFile(path.join(worldRoot, "world.yaml"), "utf-8"),
  );
  return isRecord(raw)
    ? {
        id: typeof raw.id === "string" ? raw.id : undefined,
        worldData:
          typeof raw.worldData === "string" ? raw.worldData : undefined,
      }
    : {};
}

async function resolveWorldRoot(
  worldId: string,
  worldsDirs: readonly string[],
): Promise<string | null> {
  for (const worldsDir of [...worldsDirs].reverse()) {
    const candidate = path.join(worldsDir, worldId);
    if (!(await fileExists(path.join(candidate, "world.yaml")))) continue;
    const manifest = await readWorldManifest(candidate);
    if (manifest.id === worldId) return candidate;
  }
  return null;
}

function getPreflightPluginEntry(
  deps: WorldDataImportPreflightDeps | undefined,
  pluginId: string,
): PluginRegistryEntry | undefined {
  return deps?.getPluginEntry?.(pluginId) ?? deps?.registry?.get(pluginId);
}

function preflightPluginTarget(
  target: PluginDataTarget,
  source: OrderedWorldDataSource,
  deps: WorldDataImportPreflightDeps | undefined,
): readonly WorldDataDiagnostic[] {
  const diagnostics: WorldDataDiagnostic[] = [];
  const activePlugins = deps?.activePlugins;
  if (activePlugins && !activePlugins.includes(target.pluginId)) {
    diagnostics.push({
      level: "error",
      sourceId: source.id,
      message: `worldData target plugin "${target.pluginId}" is not active for this session`,
    });
  }

  const entry = getPreflightPluginEntry(deps, target.pluginId);
  if (deps?.registry || deps?.getPluginEntry) {
    if (!entry) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `worldData target plugin "${target.pluginId}" is not registered`,
      });
    } else {
      const schema = entry.dataSchemas?.[target.namespace];
      if (!schema) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `worldData target plugin "${target.pluginId}" has no dataSchemas declaration for namespace "${target.namespace}"`,
        });
      } else if (schema.acceptsWorldData !== true) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `worldData target plugin "${target.pluginId}" namespace "${target.namespace}" does not accept world data`,
        });
      }
    }
  }
  return diagnostics;
}

async function validatePluginDataValue(options: {
  readonly target: PluginDataTarget;
  readonly source: OrderedWorldDataSource;
  readonly value: unknown;
  readonly schema?: WorldDataSchemaRef | null;
  readonly deps?: WorldDataImportPreflightDeps;
}): Promise<WorldDataDiagnostic | null> {
  const schema =
    options.schema?.kind === "plugin" &&
    options.schema.pluginId === options.target.pluginId &&
    options.schema.namespace === options.target.namespace
      ? options.schema
      : await resolveWorldDataSchema({
          source: {
            ...options.source,
            descriptor: {
              ...options.source.descriptor,
              schema: pluginSchemaUriForTarget(options.target),
            },
          },
          deps: options.deps,
        });
  if (!schema || "level" in schema) return schema;
  return validateWorldDataSchemaValue({
    schema,
    source: options.source,
    value: options.value,
    label: `worldData value for plugin "${options.target.pluginId}" namespace "${options.target.namespace}"`,
  });
}

function itemKey(
  source: OrderedWorldDataSource,
  value: unknown,
  filePath?: string,
): string | null {
  const descriptorKey = source.descriptor.key;
  if (source.descriptor.kind === "media") {
    if (descriptorKey === "filename") {
      return filePath ? path.basename(filePath) : null;
    }
    return typeof descriptorKey === "string" ? descriptorKey : null;
  }
  if (
    source.descriptor.kind === "markdown" ||
    source.descriptor.kind === "text"
  ) {
    return typeof descriptorKey === "string" ? descriptorKey : null;
  }
  if (typeof descriptorKey !== "string") return null;
  if (!isRecord(value)) return null;
  const extracted = value[descriptorKey];
  return typeof extracted === "string" || typeof extracted === "number"
    ? String(extracted)
    : null;
}

function pluginWriteIdentity(write: PlannedWrite): string | null {
  if (write.kind === "plugin-data" || write.kind === "media-index") {
    return `plugin:${write.pluginId}/${write.namespace}:${write.key}`;
  }
  if (write.kind === "lorebook") return `lorebook:${write.id}`;
  if (write.kind === "character") return `characters:${write.key}`;
  return null;
}

function sameSourceDuplicateIdentity(write: PlannedWrite): string | null {
  const identity = pluginWriteIdentity(write);
  return identity ? `${write.source.id}:${identity}` : null;
}

function isPluginTarget(
  target: ParsedWorldDataTarget | null,
): target is PluginDataTarget {
  return target?.kind === "plugin-data";
}

function pluginSchemaTargetCompatibilityDiagnostic(
  source: OrderedWorldDataSource,
  target: ParsedWorldDataTarget,
): WorldDataDiagnostic | null {
  const schemaUri = source.descriptor.schema;
  if (!schemaUri || target.kind !== "plugin-data") return null;
  const pluginSchema = parsePluginSchemaUri(schemaUri);
  if (!pluginSchema) return null;
  if (
    pluginSchema.pluginId === target.pluginId &&
    pluginSchema.namespace === target.namespace
  ) {
    return null;
  }
  return {
    level: "error",
    sourceId: source.id,
    schema: schemaUri,
    message: `worldData schema "${schemaUri}" is incompatible with target "${source.descriptor.to}"; plugin schema namespace must match the plugin target`,
  };
}

function valuesForSourceSchemaValidation(
  source: OrderedWorldDataSource,
  value: unknown,
): readonly unknown[] {
  if (source.descriptor.kind === "media") return [];
  if (
    source.descriptor.key &&
    Array.isArray(value) &&
    source.descriptor.schema !== "covel://world/dimensions"
  ) {
    return value;
  }
  return [value];
}

function validateSourceSchemaValues(options: {
  readonly source: OrderedWorldDataSource;
  readonly schema: WorldDataSchemaRef | null;
  readonly target: ParsedWorldDataTarget;
  readonly value: unknown;
}): readonly WorldDataDiagnostic[] {
  if (!options.schema) return [];
  if (
    options.schema.kind === "plugin" &&
    options.target.kind === "plugin-data" &&
    options.schema.pluginId === options.target.pluginId &&
    options.schema.namespace === options.target.namespace
  ) {
    return [];
  }
  const diagnostics: WorldDataDiagnostic[] = [];
  for (const value of valuesForSourceSchemaValidation(
    options.source,
    options.value,
  )) {
    const validation = validateWorldDataSchemaValue({
      schema: options.schema,
      source: options.source,
      value,
      label: `worldData source "${options.source.id}" value`,
    });
    if (validation) diagnostics.push(validation);
  }
  return diagnostics;
}

function valueToLorebookContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.content === "string")
    return value.content;
  return canonicalJson(value);
}

function lorebookRecordValue(write: PlannedWrite & { kind: "lorebook" }) {
  return isRecord(write.value) ? write.value : { content: write.content };
}

function stableImportValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    typeof value.importedAt === "string" &&
    typeof value.sourceWorldId === "string" &&
    typeof value.sourceId === "string"
  ) {
    const { importedAt: _importedAt, ...rest } = value;
    return rest;
  }
  return value;
}

function stableCharacterValue(record: CharacterRecord): unknown {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record;
  return rest;
}

function stableLorebookValue(record: LorebookEntryRecord): unknown {
  const {
    sessionId: _sessionId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = record;
  return rest;
}

function hashImportValue(value: unknown): string {
  return sha256Hex(canonicalJson(stableImportValue(value)));
}

function lorebookPosition(value: Record<string, unknown>): string {
  if (typeof value.position === "string") return value.position;
  const coordinate = value.coordinate;
  if (isRecord(coordinate) && typeof coordinate.position === "string") {
    return coordinate.position;
  }
  return "after_plugin";
}

function lorebookStrategy(
  value: Record<string, unknown>,
): "constant" | "selective" {
  if (value.strategy === "selective") return "selective";
  if (value.kind === "triggered") return "selective";
  return "constant";
}

function characterMirrorWrites(options: {
  source: OrderedWorldDataSource;
  sourceDigest: string;
  character: CharacterRecord;
  deps?: WorldDataImportPreflightDeps;
}): PlannedWrite[] {
  return characterMirrorTargets(options.deps).map((target) => ({
    kind: "plugin-data" as const,
    target: target.target,
    source: options.source,
    sourceDigest: options.sourceDigest,
    pluginId: target.pluginId,
    namespace: target.namespace,
    key: options.character.id,
    value: options.character,
    derivedFrom: [options.character.id],
  }));
}

function derivedPluginTargetsForSource(
  source: OrderedWorldDataSource,
  deps: WorldDataImportPreflightDeps | undefined,
): readonly PluginDataTarget[] {
  const target = parseWorldDataTarget(source.descriptor.to);
  const targets: PluginDataTarget[] = [];
  if (isPluginTarget(target)) targets.push(target);
  if (source.descriptor.indexTo) {
    const indexTarget = parseWorldDataIndexTarget(source.descriptor.indexTo);
    if (indexTarget) targets.push(indexTarget);
  }
  if (source.descriptor.effects?.includes("characters")) {
    for (const target of characterMirrorTargets(deps)) {
      targets.push({
        kind: "plugin-data",
        pluginId: target.pluginId,
        namespace: target.namespace,
        lorebook: false,
      });
    }
  }
  return targets;
}

function mediaMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function mediaIdForBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function appendStructuredPlans(options: {
  writes: PlannedWrite[];
  diagnostics: WorldDataDiagnostic[];
  source: OrderedWorldDataSource;
  target: ParsedWorldDataTarget;
  sourceDigest: string;
  value: unknown;
  sessionId: string;
  worldId: string;
  now: string;
  schema: WorldDataSchemaRef | null;
  deps?: WorldDataImportPreflightDeps;
}): Promise<void> {
  const { source, target } = options;
  if (target.kind === "world-metadata" || target.kind === "media") return;
  for (const value of sourceItems(options.value)) {
    const key = itemKey(source, value);
    if (!key) {
      options.diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `source "${source.id}" needs a resolvable key for target ${source.descriptor.to}`,
      });
      continue;
    }

    if (target.kind === "plugin-data") {
      const pluginValue = characterBlueprintAdapter({
        target,
        value,
        sessionId: options.sessionId,
        worldId: options.worldId,
        sourceId: source.id,
        now: options.now,
      }).value;
      const validationError = await validatePluginDataValue({
        target,
        source,
        value: pluginValue,
        schema: options.schema,
        deps: options.deps,
      });
      if (validationError) {
        options.diagnostics.push(validationError);
        continue;
      }
      options.writes.push({
        kind: "plugin-data",
        target: source.descriptor.to,
        source,
        sourceDigest: options.sourceDigest,
        pluginId: target.pluginId,
        namespace: target.namespace,
        key,
        value: pluginValue,
      });
      if (target.lorebook) {
        options.writes.push({
          kind: "lorebook",
          target: source.descriptor.to,
          source,
          sourceDigest: options.sourceDigest,
          id: `${target.pluginId}:${target.namespace}:${key}`,
          pluginId: target.pluginId,
          content: valueToLorebookContent(value),
          value,
          derivedFrom: [key],
        });
      }
    } else if (target.kind === "lorebook") {
      options.writes.push({
        kind: "lorebook",
        target: source.descriptor.to,
        source,
        sourceDigest: options.sourceDigest,
        id: key,
        pluginId: "world-data",
        content: valueToLorebookContent(value),
        value,
      });
    } else if (target.kind === "characters") {
      const record = characterRecordFromValue(
        options.sessionId,
        value,
        options.now,
      );
      if (!record) {
        options.diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `source "${source.id}" item cannot become a character record`,
        });
        continue;
      }
      options.writes.push({
        kind: "character",
        target: source.descriptor.to,
        source,
        sourceDigest: options.sourceDigest,
        key,
        record,
        value,
      });
    }

    if (source.descriptor.effects?.includes("characters")) {
      const character = characterRecordForCharacterEffect({
        sessionId: options.sessionId,
        value,
        now: options.now,
      });
      if (!character) continue;
      options.writes.push({
        kind: "character",
        target: "characters",
        source,
        sourceDigest: options.sourceDigest,
        key: character.id,
        record: character,
        value: character,
        derivedFrom: [key],
      });
      options.writes.push(
        ...characterMirrorWrites({
          source,
          sourceDigest: options.sourceDigest,
          character,
          deps: options.deps,
        }),
      );
    }
  }
}

async function buildImportPlan(options: {
  sessionId: string;
  worldId: string;
  sources: readonly OrderedWorldDataSource[];
  deps?: WorldDataImportPreflightDeps;
  now: string;
}): Promise<ImportPlan> {
  const writes: PlannedWrite[] = [];
  const diagnostics: WorldDataDiagnostic[] = [];

  for (const source of options.sources) {
    const target = parseWorldDataTarget(source.descriptor.to);
    if (!target) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `invalid target URI: ${source.descriptor.to}`,
      });
      continue;
    }
    const preflightedTargets = new Set<string>();
    for (const pluginTarget of derivedPluginTargetsForSource(
      source,
      options.deps,
    )) {
      const identity = `${pluginTarget.pluginId}/${pluginTarget.namespace}`;
      if (preflightedTargets.has(identity)) continue;
      preflightedTargets.add(identity);
      diagnostics.push(
        ...preflightPluginTarget(pluginTarget, source, options.deps),
      );
    }
    if (source.descriptor.indexTo) {
      if (!parseWorldDataIndexTarget(source.descriptor.indexTo)) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `invalid indexTo URI: ${source.descriptor.indexTo}`,
        });
      }
    }
    const compatibilityDiagnostic = pluginSchemaTargetCompatibilityDiagnostic(
      source,
      target,
    );
    if (compatibilityDiagnostic) {
      diagnostics.push(compatibilityDiagnostic);
      continue;
    }
    const resolvedSchema = await resolveWorldDataSchema({
      source,
      deps: options.deps,
    });
    if (resolvedSchema && "level" in resolvedSchema) {
      diagnostics.push({ sourceId: source.id, ...resolvedSchema });
      continue;
    }

    const read = await readWorldDataSource(source);
    diagnostics.push(...read.diagnostics);
    if (read.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      continue;
    }
    if (!read.path) continue;

    const mediaFiles =
      source.descriptor.kind === "media"
        ? await collectMediaSourceFiles(source, read.path)
        : null;
    if (mediaFiles) diagnostics.push(...mediaFiles.diagnostics);
    if (
      mediaFiles?.diagnostics.some((diagnostic) => diagnostic.level === "error")
    ) {
      continue;
    }

    const schemaDiagnostics = validateSourceSchemaValues({
      source,
      schema: resolvedSchema,
      target,
      value: read.value,
    });
    diagnostics.push(...schemaDiagnostics);
    if (schemaDiagnostics.some((diagnostic) => diagnostic.level === "error")) {
      continue;
    }

    const sourceDigest =
      source.descriptor.kind === "media"
        ? (mediaFiles?.digest ?? sha256Hex(""))
        : (await digestFile(read.path)).digest;

    if (source.descriptor.kind === "media") {
      const indexTarget = source.descriptor.indexTo
        ? parseWorldDataIndexTarget(source.descriptor.indexTo)
        : null;
      for (const mediaPath of mediaFiles?.files ?? []) {
        const key = itemKey(source, undefined, mediaPath);
        if (!key) {
          diagnostics.push({
            level: "error",
            sourceId: source.id,
            message: `media source "${source.id}" needs key: filename or a literal key`,
          });
          continue;
        }
        if (indexTarget) {
          const value = {
            import: {
              path: mediaPath,
              filename: path.basename(mediaPath),
              mime: mediaMime(mediaPath),
            },
          };
          const validationError = await validatePluginDataValue({
            target: indexTarget,
            source,
            value,
            schema: null,
            deps: options.deps,
          });
          if (validationError) {
            diagnostics.push(validationError);
            continue;
          }
          writes.push({
            kind: "media-index",
            target: source.descriptor.indexTo!,
            source,
            sourceDigest,
            pluginId: indexTarget.pluginId,
            namespace: indexTarget.namespace,
            key,
            value,
          });
        }
      }
      continue;
    }

    await appendStructuredPlans({
      writes,
      diagnostics,
      source,
      target,
      sourceDigest,
      value: read.value,
      sessionId: options.sessionId,
      worldId: options.worldId,
      now: options.now,
      schema: resolvedSchema,
      deps: options.deps,
    });
  }

  const sameSource = new Map<string, PlannedWrite>();
  for (const write of writes) {
    const identity = sameSourceDuplicateIdentity(write);
    if (!identity) continue;
    const existing = sameSource.get(identity);
    if (existing) {
      diagnostics.push({
        level: "error",
        sourceId: write.source.id,
        message: `duplicate worldData target/key in source "${write.source.id}": ${pluginWriteIdentity(write)}`,
      });
    } else {
      sameSource.set(identity, write);
    }
  }

  const byIdentity = new Map<string, PlannedWrite>();
  const mergeEvents: MergeEvent[] = [];
  const merged: PlannedWrite[] = [];
  for (const write of writes) {
    const identity = pluginWriteIdentity(write);
    if (!identity) {
      merged.push(write);
      continue;
    }
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, write);
      merged.push(write);
      continue;
    }
    if (existing.source.id !== write.source.id) {
      mergeEvents.push({
        level: "warning",
        sourceId: write.source.id,
        message: `worldData ${identity} from source "${write.source.id}" replaces source "${existing.source.id}"`,
      });
      const index = merged.indexOf(existing);
      if (index >= 0) merged[index] = write;
      byIdentity.set(identity, write);
    }
  }

  return { writes: merged, diagnostics, mergeEvents };
}

async function existingKeySet(options: {
  store: DataStore;
  sessionId: string;
  writes: readonly PlannedWrite[];
}): Promise<ReadonlySet<string>> {
  const existing = new Set<string>();
  for (const write of options.writes) {
    if (write.kind === "plugin-data" || write.kind === "media-index") {
      const record = await options.store.getPluginData(
        options.sessionId,
        write.pluginId,
        write.namespace,
        write.key,
      );
      if (record) existing.add(pluginWriteIdentity(write)!);
    } else if (write.kind === "lorebook") {
      const entries = await options.store.listSessionLorebookEntries(
        options.sessionId,
      );
      if (entries.some((entry) => entry.id === write.id)) {
        existing.add(pluginWriteIdentity(write)!);
      }
    } else if (write.kind === "character") {
      const characters = await options.store.listCharacters(options.sessionId);
      if (characters.some((character) => character.id === write.key)) {
        existing.add(pluginWriteIdentity(write)!);
      }
    }
  }
  return existing;
}

function toPluginDataRecord(
  sessionId: string,
  write: PlannedWrite & ({ kind: "plugin-data" } | { kind: "media-index" }),
  now: string,
): PluginDataRecord {
  return {
    id: randomUUID(),
    sessionId,
    pluginId: write.pluginId,
    namespace: write.namespace,
    key: write.key,
    value: write.value,
    createdAt: now,
    updatedAt: now,
  };
}

function toLorebookRecord(
  sessionId: string,
  write: PlannedWrite & { kind: "lorebook" },
  insertionOrder: number,
  now: string,
): LorebookEntryRecord {
  const value = lorebookRecordValue(write);
  return {
    id: write.id,
    sessionId,
    pluginId: write.pluginId,
    keys: Array.isArray(value.keys)
      ? value.keys.filter((key): key is string => typeof key === "string")
      : [],
    content: write.content,
    strategy: lorebookStrategy(value),
    position: lorebookPosition(value),
    insertionOrder:
      typeof value.insertionOrder === "number"
        ? value.insertionOrder
        : insertionOrder,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    ...(value.extra !== undefined ? { extra: value.extra } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function ledgerForWrite(options: {
  sessionId: string;
  worldId: string;
  write: PlannedWrite;
  now: string;
  valueHash: string;
}): WorldDataImportLedgerRecord {
  const { write } = options;
  const key =
    write.kind === "plugin-data" || write.kind === "media-index"
      ? write.key
      : write.kind === "lorebook"
        ? write.id
        : write.key;
  return {
    id: randomUUID(),
    sessionId: options.sessionId,
    target: write.target,
    ...((write.kind === "plugin-data" || write.kind === "media-index") && {
      pluginId: write.pluginId,
      namespace: write.namespace,
    }),
    key,
    sourceWorldId: options.worldId,
    sourceId: write.source.id,
    sourceDigest: write.sourceDigest,
    valueHash: options.valueHash,
    ...(write.source.descriptor.schema
      ? { schemaRef: write.source.descriptor.schema }
      : {}),
    ...(write.derivedFrom ? { derivedFrom: write.derivedFrom } : {}),
    importedAt: options.now,
    managed: true,
  };
}

function valueHashForWrite(options: {
  sessionId: string;
  write: PlannedWrite;
  lorebookRecord?: LorebookEntryRecord;
}): string {
  const { write } = options;
  if (write.kind === "character") {
    return sha256Hex(canonicalJson(stableCharacterValue(write.record)));
  }
  if (write.kind === "lorebook") {
    if (!options.lorebookRecord) {
      throw new Error("missing lorebook record for worldData ledger hash");
    }
    return sha256Hex(
      canonicalJson(stableLorebookValue(options.lorebookRecord)),
    );
  }
  return hashImportValue(write.value);
}

function ledgerKey(ledger: WorldDataImportLedgerRecord): string {
  return `${ledger.target}:${ledger.pluginId ?? ""}:${ledger.namespace ?? ""}:${ledger.key ?? ""}`;
}

function writeKey(write: PlannedWrite): string {
  if (write.kind === "plugin-data" || write.kind === "media-index") {
    return `${write.target}:${write.pluginId}:${write.namespace}:${write.key}`;
  }
  if (write.kind === "lorebook") {
    return `${write.target}:::${write.id}`;
  }
  return `${write.target}:::${write.key}`;
}

async function maybeDeleteOwnedUnreferencedMedia(options: {
  mediaStore: MediaStore;
  mediaId: string;
  sessionId: string;
}): Promise<void> {
  const lookup = await options.mediaStore.lookup(options.mediaId);
  if (lookup?.ownerSessionId !== options.sessionId) return;
  const refs = (await options.mediaStore.listRefs()).filter(
    (ref) => ref.mediaId === options.mediaId,
  );
  if (refs.length > 0) return;
  await options.mediaStore.delete(options.mediaId, { force: true });
}

async function currentHashForLedger(options: {
  store: DataStore;
  sessionId: string;
  ledger: WorldDataImportLedgerRecord;
}): Promise<string | null> {
  const { store, sessionId, ledger } = options;
  if (
    ledger.target.startsWith("plugin:") &&
    ledger.pluginId &&
    ledger.namespace &&
    ledger.key
  ) {
    const record = await store.getPluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    return record ? hashImportValue(record.value) : null;
  }
  if (ledger.target === "characters" && ledger.key) {
    const record = (await store.listCharacters(sessionId)).find(
      (character) => character.id === ledger.key,
    );
    return record
      ? sha256Hex(canonicalJson(stableCharacterValue(record)))
      : null;
  }
  if (ledger.key) {
    const record = (await store.listSessionLorebookEntries(sessionId)).find(
      (entry) => entry.id === ledger.key,
    );
    return record
      ? sha256Hex(canonicalJson(stableLorebookValue(record)))
      : null;
  }
  return null;
}

async function deleteLedgerTarget(options: {
  store: DataStore;
  mediaStore?: MediaStore;
  sessionId: string;
  ledger: WorldDataImportLedgerRecord;
}): Promise<void> {
  const { store, sessionId, ledger } = options;
  if (
    ledger.target.startsWith("plugin:") &&
    ledger.pluginId &&
    ledger.namespace &&
    ledger.key
  ) {
    const existing = await store.getPluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    await store.deletePluginData(
      sessionId,
      ledger.pluginId,
      ledger.namespace,
      ledger.key,
    );
    if (options.mediaStore) {
      const ref =
        isRecord(existing?.value) && isRecord(existing.value.ref)
          ? existing.value.ref
          : undefined;
      const mediaId = typeof ref?.id === "string" ? ref.id : undefined;
      if (mediaId) {
        try {
          await options.mediaStore.removeRef(mediaId, sessionId);
          await maybeDeleteOwnedUnreferencedMedia({
            mediaStore: options.mediaStore,
            mediaId,
            sessionId,
          });
        } catch {
          // Data sync should continue deleting the remaining managed rows.
        }
      }
    }
    return;
  }
  if (ledger.target === "characters" && ledger.key) {
    await store.deleteCharacter(sessionId, ledger.key);
    return;
  }
  if (ledger.key) {
    await store.deleteLorebookEntry(sessionId, ledger.key);
  }
}

function syncConflictForLedger(
  ledger: WorldDataImportLedgerRecord,
  reason: "modified" | "missing",
): SyncWorldDataForSessionResult["conflicts"][number] {
  return {
    target: ledger.target,
    ...(ledger.key ? { key: ledger.key } : {}),
    sourceId: ledger.sourceId,
    reason,
  };
}

async function materializeMediaIndexWrites(options: {
  mediaStore?: MediaStore;
  sessionId: string;
  writes: readonly PlannedWrite[];
}): Promise<{
  readonly writes: readonly PlannedWrite[];
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}> {
  const out: PlannedWrite[] = [];
  const mediaRefs: WorldDataImportedMediaRef[] = [];
  for (const write of options.writes) {
    if (write.kind !== "media-index") {
      out.push(write);
      continue;
    }
    const importInfo = isRecord(write.value)
      ? (write.value.import as unknown)
      : undefined;
    const mediaPath =
      isRecord(importInfo) && typeof importInfo.path === "string"
        ? importInfo.path
        : undefined;
    if (!mediaPath || !options.mediaStore) {
      out.push(write);
      continue;
    }
    const bytes = await readFile(mediaPath);
    const mediaId = mediaIdForBytes(bytes);
    const existing = await options.mediaStore.lookup(mediaId);
    const existingRefs = existing
      ? (await options.mediaStore.listRefs()).filter(
          (ref) => ref.mediaId === mediaId,
        )
      : [];
    const cleanupOnFailure =
      !existing ||
      (existing.ownerSessionId === null && existingRefs.length === 0);
    const ref = await options.mediaStore.put(bytes, mediaMime(mediaPath), {
      filename: path.basename(mediaPath),
      sourceId: write.source.id,
    });
    mediaRefs.push({
      id: ref.id,
      sessionId: options.sessionId,
      pluginId: write.pluginId,
      cleanupOnFailure,
    });
    out.push({
      ...write,
      value: {
        ref,
        filename: path.basename(mediaPath),
        sourceId: write.source.id,
      },
    });
  }
  return { writes: out, mediaRefs };
}

export async function finalizeWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  for (const ref of options.refs) {
    await options.mediaStore.recordOwnership(
      ref.id,
      ref.sessionId,
      ref.pluginId,
    );
    await options.mediaStore.addRef(ref.id, ref.sessionId, ref.pluginId);
  }
}

export async function cleanupWorldDataMediaRefs(options: {
  mediaStore?: MediaStore;
  refs: readonly WorldDataImportedMediaRef[];
}): Promise<void> {
  if (!options.mediaStore) return;
  for (const ref of [...options.refs].reverse()) {
    if (!ref.cleanupOnFailure) continue;
    try {
      await options.mediaStore.delete(ref.id, { force: true });
    } catch {
      // Preserve the import/finalize failure as the caller-visible error.
    }
  }
}

async function writeImportPlan(options: {
  store: DataStore;
  mediaStore?: MediaStore;
  sessionId: string;
  worldId: string;
  now: string;
  plan: ImportPlan;
  deferMediaFinalize?: boolean;
}): Promise<{
  written: number;
  skipped: number;
  mediaRefs: readonly WorldDataImportedMediaRef[];
}> {
  if (
    options.plan.diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    throw new Error(
      `invalid worldData import plan for "${options.worldId}": ${options.plan.diagnostics
        .filter((diagnostic) => diagnostic.level === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  const existing = await existingKeySet({
    store: options.store,
    sessionId: options.sessionId,
    writes: options.plan.writes,
  });
  const seen = new Set<string>();
  const selected: PlannedWrite[] = [];
  let skipped = 0;
  for (const write of options.plan.writes) {
    const identity = pluginWriteIdentity(write);
    if (
      write.source.descriptor.merge === "skipExisting" &&
      identity &&
      (seen.has(identity) || existing.has(identity))
    ) {
      skipped++;
      continue;
    }
    if (identity) seen.add(identity);
    selected.push(write);
  }

  let materialized:
    | Awaited<ReturnType<typeof materializeMediaIndexWrites>>
    | undefined;
  try {
    materialized = await materializeMediaIndexWrites({
      mediaStore: options.mediaStore,
      sessionId: options.sessionId,
      writes: selected,
    });
    const materializedWrites = materialized.writes;

    const pluginWrites = materializedWrites.filter(
      (
        write,
      ): write is PlannedWrite &
        ({ kind: "plugin-data" } | { kind: "media-index" }) =>
        write.kind === "plugin-data" || write.kind === "media-index",
    );
    const pluginRecords = pluginWrites.map((write) =>
      toPluginDataRecord(options.sessionId, write, options.now),
    );
    if (pluginRecords.length > 0) {
      await options.store.setPluginDataBatch(pluginRecords);
    }

    const lorebookEntries = materializedWrites
      .filter(
        (write): write is PlannedWrite & { kind: "lorebook" } =>
          write.kind === "lorebook",
      )
      .map((write, index) => ({
        write,
        record: toLorebookRecord(
          options.sessionId,
          write,
          500 + index * 100,
          options.now,
        ),
      }));
    const lorebookRecords = lorebookEntries.map((entry) => entry.record);
    if (lorebookRecords.length > 0) {
      await options.store.upsertLorebookEntries(lorebookRecords);
    }

    for (const write of materializedWrites) {
      if (write.kind === "character") {
        await options.store.upsertCharacter(write.record);
      }
    }

    const lorebookRecordById = new Map(
      lorebookEntries.map((entry) => [entry.write.id, entry.record]),
    );
    const ledger = materializedWrites.map((write) => {
      const lorebookRecord =
        write.kind === "lorebook"
          ? lorebookRecordById.get(write.id)
          : undefined;
      return ledgerForWrite({
        sessionId: options.sessionId,
        worldId: options.worldId,
        write,
        now: options.now,
        valueHash: valueHashForWrite({
          sessionId: options.sessionId,
          write,
          lorebookRecord,
        }),
      });
    });
    await options.store.saveWorldDataImportLedgerBatch?.(ledger);
    if (!options.deferMediaFinalize) {
      await finalizeWorldDataMediaRefs({
        mediaStore: options.mediaStore,
        refs: materialized.mediaRefs,
      });
    }

    return {
      written: materializedWrites.length,
      skipped,
      mediaRefs: materialized.mediaRefs,
    };
  } catch (err) {
    await cleanupWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: materialized?.mediaRefs ?? [],
    });
    throw err;
  }
}

export async function importWorldDataForSession(options: {
  store: DataStore;
  mediaStore?: MediaStore;
  sessionId: string;
  worldId: string | undefined;
  worldsDirs?: readonly string[];
  covelHome?: string;
  now: string;
  preflight?: WorldDataImportPreflightDeps;
  deferMediaFinalize?: boolean;
}): Promise<ImportWorldDataForSessionResult> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      written: 0,
      skipped: 0,
      mediaRefs: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  const descriptorErrors = descriptor.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (descriptorErrors.length > 0) {
    throw new Error(
      `invalid worldData descriptor for "${options.worldId}": ${descriptorErrors
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const preflight = {
    ...options.preflight,
    activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
  };
  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: preflight,
    now: options.now,
  });
  const result = await writeImportPlan({
    store: options.store,
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    worldId: options.worldId,
    now: options.now,
    plan,
    deferMediaFinalize: options.deferMediaFinalize,
  });

  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    planned: plan.writes.length,
    written: result.written,
    skipped: result.skipped,
    mediaRefs: result.mediaRefs,
  };
}

export async function preflightWorldDataForSession(options: {
  sessionId: string;
  worldId: string | undefined;
  worldsDirs?: readonly string[];
  covelHome?: string;
  now: string;
  preflight?: WorldDataImportPreflightDeps;
}): Promise<PreflightWorldDataForSessionResult> {
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      diagnostics: [],
      planned: 0,
      targets: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  if (
    descriptor.diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    return {
      imported: true,
      diagnostics: descriptor.diagnostics,
      planned: 0,
      targets: [],
    };
  }

  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: options.preflight,
    now: options.now,
  });

  return {
    imported: true,
    diagnostics: [
      ...descriptor.diagnostics,
      ...plan.diagnostics,
      ...plan.mergeEvents,
    ],
    planned: plan.writes.length,
    targets: plan.writes.map((write) => ({
      kind: write.kind,
      target: write.target,
      sourceId: write.source.id,
      ...((write.kind === "plugin-data" || write.kind === "media-index") && {
        pluginId: write.pluginId,
        namespace: write.namespace,
        key: write.key,
      }),
      ...(write.kind === "lorebook" && {
        pluginId: write.pluginId,
        key: write.id,
      }),
      ...(write.kind === "character" && { key: write.key }),
    })),
  };
}

export async function syncWorldDataForSession(options: {
  store: DataStore;
  mediaStore?: MediaStore;
  sessionId: string;
  worldId: string | undefined;
  worldsDirs?: readonly string[];
  covelHome?: string;
  now: string;
  preflight?: WorldDataImportPreflightDeps;
  dryRun?: boolean;
  force?: boolean;
  deferMediaFinalize?: boolean;
}): Promise<SyncWorldDataForSessionResult> {
  const dryRun = options.dryRun === true;
  if (!options.worldId || !options.worldsDirs?.length) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) {
    return {
      imported: false,
      dryRun,
      diagnostics: [],
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  const descriptorErrors = descriptor.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (descriptorErrors.length > 0) {
    return {
      imported: true,
      dryRun,
      diagnostics: descriptor.diagnostics,
      planned: 0,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const session =
    !options.preflight?.activePlugins && options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const preflight = {
    ...options.preflight,
    activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
  };
  const plan = await buildImportPlan({
    sessionId: options.sessionId,
    worldId: options.worldId,
    sources: descriptor.sources,
    deps: preflight,
    now: options.now,
  });
  const diagnostics = [
    ...descriptor.diagnostics,
    ...plan.diagnostics,
    ...plan.mergeEvents,
  ];
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return {
      imported: true,
      dryRun,
      diagnostics,
      planned: plan.writes.length,
      upserted: 0,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
      mediaRefs: [],
    };
  }

  const ledgers = (
    await options.store.listWorldDataImportLedger(options.sessionId)
  ).filter(
    (ledger) => ledger.managed && ledger.sourceWorldId === options.worldId,
  );
  const ledgerByKey = new Map(
    ledgers.map((ledger) => [ledgerKey(ledger), ledger]),
  );
  const writesByKey = new Map(
    plan.writes.map((write) => [writeKey(write), write]),
  );
  const conflicts: Array<SyncWorldDataForSessionResult["conflicts"][number]> =
    [];
  let unchanged = 0;
  let upserted = 0;
  let deleted = 0;
  const writesToApply: PlannedWrite[] = [];
  const ledgersToDelete: WorldDataImportLedgerRecord[] = [];

  for (const ledger of ledgers) {
    if (writesByKey.has(ledgerKey(ledger))) continue;
    const currentHash = await currentHashForLedger({
      store: options.store,
      sessionId: options.sessionId,
      ledger,
    });
    if (currentHash === null) {
      ledgersToDelete.push(ledger);
      deleted++;
      continue;
    }
    if (currentHash !== ledger.valueHash && !options.force) {
      conflicts.push(syncConflictForLedger(ledger, "modified"));
      continue;
    }
    ledgersToDelete.push(ledger);
    deleted++;
  }

  for (const write of plan.writes) {
    const key = writeKey(write);
    const ledger = ledgerByKey.get(key);
    if (!ledger) {
      writesToApply.push(write);
      upserted++;
      continue;
    }
    const currentHash = await currentHashForLedger({
      store: options.store,
      sessionId: options.sessionId,
      ledger,
    });
    if (currentHash === null) {
      if (!options.force) {
        conflicts.push(syncConflictForLedger(ledger, "missing"));
        continue;
      }
      ledgersToDelete.push(ledger);
      writesToApply.push(write);
      upserted++;
      continue;
    }
    if (currentHash !== ledger.valueHash && !options.force) {
      conflicts.push(syncConflictForLedger(ledger, "modified"));
      continue;
    }
    if (write.sourceDigest === ledger.sourceDigest) {
      unchanged++;
      continue;
    }
    ledgersToDelete.push(ledger);
    writesToApply.push(write);
    upserted++;
  }

  if (dryRun || conflicts.length > 0) {
    return {
      imported: true,
      dryRun,
      diagnostics,
      planned: plan.writes.length,
      upserted,
      deleted,
      unchanged,
      conflicts,
      mediaRefs: [],
    };
  }

  const mediaRefs: WorldDataImportedMediaRef[] = [];
  try {
    await options.store.beginTx();
    for (const ledger of ledgersToDelete) {
      await deleteLedgerTarget({
        store: options.store,
        mediaStore: options.mediaStore,
        sessionId: options.sessionId,
        ledger,
      });
      await options.store.deleteWorldDataImportLedger(
        options.sessionId,
        ledger.id,
      );
    }
    if (writesToApply.length > 0) {
      const writeResult = await writeImportPlan({
        store: options.store,
        mediaStore: options.mediaStore,
        sessionId: options.sessionId,
        worldId: options.worldId,
        now: options.now,
        plan: { writes: writesToApply, diagnostics: [], mergeEvents: [] },
        deferMediaFinalize: options.deferMediaFinalize,
      });
      mediaRefs.push(...writeResult.mediaRefs);
    }
    await options.store.commitTx();
  } catch (err) {
    await options.store.rollbackTx();
    await cleanupWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
    throw err;
  }

  if (options.deferMediaFinalize) {
    await finalizeWorldDataMediaRefs({
      mediaStore: options.mediaStore,
      refs: mediaRefs,
    });
  }

  return {
    imported: true,
    dryRun,
    diagnostics,
    planned: plan.writes.length,
    upserted,
    deleted,
    unchanged,
    conflicts,
    mediaRefs,
  };
}
