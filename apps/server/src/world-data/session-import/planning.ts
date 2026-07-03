import path from "node:path";
import { canonicalJson, digestFile, sha256Hex } from "../digest.js";
import { collectMediaSourceFiles } from "../media.js";
import { readWorldDataSource } from "../source-reader.js";
import {
  characterBlueprintAdapter,
  characterMirrorTargets,
  characterRecordForCharacterEffect,
  characterRecordFromValue,
} from "../character-effects.js";
import {
  resolveWorldDataSchema,
  type WorldDataSchemaRef,
} from "../schema-registry.js";
import {
  parseWorldDataIndexTarget,
  parseWorldDataTarget,
  type ParsedWorldDataTarget,
} from "../target-uri.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import {
  pluginWriteIdentity,
  sameSourceDuplicateIdentity,
} from "./identity.js";
import { mediaMime } from "./media-handling.js";
import type {
  ImportPlan,
  MergeEvent,
  PlannedWrite,
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";
import { isRecord, sourceItems } from "./utils.js";
import {
  pluginSchemaTargetCompatibilityDiagnostic,
  preflightPluginTarget,
  validatePluginDataValue,
  validateSourceSchemaValues,
} from "./validation.js";

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

function isPluginTarget(
  target: ParsedWorldDataTarget | null,
): target is PluginDataTarget {
  return target?.kind === "plugin-data";
}

function valueToLorebookContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.content === "string")
    return value.content;
  return canonicalJson(value);
}

function characterMirrorWrites(options: {
  source: OrderedWorldDataSource;
  sourceDigest: string;
  character: Extract<PlannedWrite, { kind: "character" }>["record"];
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

export async function buildImportPlan(options: {
  sessionId: string;
  worldId: string;
  sources: readonly OrderedWorldDataSource[];
  deps?: WorldDataImportPreflightDeps;
  now: string;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  locale?: string;
}): Promise<ImportPlan> {
  const writes: PlannedWrite[] = [];
  const diagnostics: WorldDataDiagnostic[] = [];

  const activePlugins = options.deps?.activePlugins;

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
    // A source whose destination plugin the player left inactive is skipped
    // with a warning, never a session-blocking error — plugin selection is
    // player-facing, so any world shipping data for an optional plugin would
    // otherwise 500 on session creation the moment that plugin is
    // deselected. Data without a consumer is harmless to omit; authoring
    // errors (schema mismatch, non-accepting namespace) below stay errors.
    if (
      isPluginTarget(target) &&
      activePlugins &&
      !activePlugins.includes(target.pluginId)
    ) {
      diagnostics.push({
        level: "warning",
        sourceId: source.id,
        message: `worldData target plugin "${target.pluginId}" is not active for this session; source "${source.id}" skipped`,
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

    const read = await readWorldDataSource(source, options.locale);
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
      let indexTarget = source.descriptor.indexTo
        ? parseWorldDataIndexTarget(source.descriptor.indexTo)
        : null;
      // Same player-facing rule as the primary target above — but the media
      // bytes still import (characters may reference them); only the
      // plugin-data index writes are dropped.
      if (
        indexTarget &&
        activePlugins &&
        !activePlugins.includes(indexTarget.pluginId)
      ) {
        diagnostics.push({
          level: "warning",
          sourceId: source.id,
          message: `worldData indexTo plugin "${indexTarget.pluginId}" is not active for this session; index writes for source "${source.id}" skipped`,
        });
        indexTarget = null;
      }
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
