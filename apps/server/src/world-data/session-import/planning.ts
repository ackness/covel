import {
  resolveWorldDataTargets,
  type ResolvedWorldDataTarget,
} from "../contract-targets.js";
import path from "node:path";
import { canonicalJson, digestFile, sha256Hex } from "../digest.js";
import { collectMediaSourceFiles } from "../media.js";
import { readWorldDataSource } from "../source-reader.js";
import { characterRecordFromValue } from "../character-effects.js";
import {
  resolveWorldDataSchema,
  type WorldDataSchemaRef,
} from "../schema-registry.js";
import {
  parseWorldDataIndexTarget,
  parseWorldDataTarget,
} from "../target-uri.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import {
  pluginWriteIdentity,
  sameSourceDuplicateIdentity,
} from "./identity.js";
import { mediaMime } from "./media-handling.js";
import { executeWorldProjections } from "./projections.js";
import type {
  ImportPlan,
  MergeEvent,
  PlannedWrite,
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";
import { isRecord, sourceItems } from "./utils.js";
import {
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
  target: ResolvedWorldDataTarget | null,
): target is PluginDataTarget {
  return target?.kind === "plugin-data";
}

function valueToLorebookContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.content === "string")
    return value.content;
  return canonicalJson(value);
}

async function appendStructuredPlans(options: {
  writes: PlannedWrite[];
  diagnostics: WorldDataDiagnostic[];
  source: OrderedWorldDataSource;
  target: ResolvedWorldDataTarget;
  sourceDigest: string;
  value: unknown;
  sessionId: string;
  worldId: string;
  now: string;
  schema: WorldDataSchemaRef | null;
  deps?: WorldDataImportPreflightDeps;
  includeKernelEffects?: boolean;
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
      const pluginValue = value;
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
      if (target.lorebook && options.includeKernelEffects !== false) {
        options.writes.push({
          kind: "lorebook",
          target: source.descriptor.to,
          source,
          sourceDigest: options.sourceDigest,
          id: `${source.id}:${key}`,
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
        key: record.id,
        record,
        value,
      });
    }

    if (
      options.includeKernelEffects !== false &&
      source.descriptor.effects?.includes("characters")
    ) {
      const character = characterRecordFromValue(
        options.sessionId,
        value,
        options.now,
      );
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
  const deferredProjectionOutputs: ImportPlan["deferredProjectionOutputs"][number][] =
    [];

  for (const source of options.sources) {
    const parsedTarget = parseWorldDataTarget(source.descriptor.to);
    if (!parsedTarget) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `invalid target URI: ${source.descriptor.to}`,
      });
      continue;
    }
    const targets = resolveWorldDataTargets(
      parsedTarget,
      options.deps,
      source.id,
      diagnostics,
    );
    const parsedIndex = source.descriptor.indexTo
      ? parseWorldDataIndexTarget(source.descriptor.indexTo)
      : null;
    const indexTargets = parsedIndex
      ? resolveWorldDataTargets(
          parsedIndex,
          options.deps,
          source.id,
          diagnostics,
        ).filter(isPluginTarget)
      : [];
    const preflightedTargets = new Set<string>();
    for (const pluginTarget of [
      ...targets.filter(isPluginTarget),
      ...indexTargets,
    ]) {
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
      target: targets[0],
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
        for (const indexTarget of indexTargets) {
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

    for (const target of targets) {
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
        includeKernelEffects: target === targets[0],
      });
    }

    const projections = await executeWorldProjections({
      source,
      sourceDigest,
      value: read.value,
      sessionId: options.sessionId,
      worldId: options.worldId,
      ...(options.locale ? { locale: options.locale } : {}),
      now: options.now,
      deps: options.deps,
    });
    writes.push(...projections.writes);
    diagnostics.push(...projections.diagnostics);
    deferredProjectionOutputs.push(...projections.deferredProjectionOutputs);
  }

  const sameSource = new Map<
    string,
    { readonly write: PlannedWrite; readonly index: number }
  >();
  const deduplicatedWrites: PlannedWrite[] = [];
  for (const write of writes) {
    const identity = sameSourceDuplicateIdentity(write);
    if (!identity) {
      deduplicatedWrites.push(write);
      continue;
    }
    const existing = sameSource.get(identity);
    if (existing) {
      const existingProjection = existing.write.derivedFrom?.find((item) =>
        item.startsWith("projection:"),
      );
      const currentProjection = write.derivedFrom?.find((item) =>
        item.startsWith("projection:"),
      );
      if (existingProjection || currentProjection) {
        // Projections are optional derived views. A duplicate key from a
        // projection must not turn an otherwise valid canonical import into a
        // session-blocking error. Canonical writes win; between projections,
        // the first stable plugin/projection/output order wins.
        const replaceExisting = Boolean(
          existingProjection && !currentProjection,
        );
        if (replaceExisting) {
          deduplicatedWrites[existing.index] = write;
          sameSource.set(identity, { write, index: existing.index });
        }
        diagnostics.push({
          level: "warning",
          sourceId: write.source.id,
          message: `worldData projection target/key collision in source "${write.source.id}": ${pluginWriteIdentity(write)}; ${replaceExisting ? "canonical write replaced the projection" : "later projection write skipped"}`,
        });
        continue;
      }
      diagnostics.push({
        level: "error",
        sourceId: write.source.id,
        message: `duplicate worldData target/key in source "${write.source.id}": ${pluginWriteIdentity(write)}`,
      });
    } else {
      sameSource.set(identity, {
        write,
        index: deduplicatedWrites.length,
      });
      deduplicatedWrites.push(write);
    }
  }

  const byIdentity = new Map<string, PlannedWrite>();
  const mergeEvents: MergeEvent[] = [];
  const merged: PlannedWrite[] = [];
  for (const write of deduplicatedWrites) {
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
      const existingProjection = existing.derivedFrom?.find((item) =>
        item.startsWith("projection:"),
      );
      const currentProjection = write.derivedFrom?.find((item) =>
        item.startsWith("projection:"),
      );
      if (!existingProjection && currentProjection) {
        // A projection cannot shadow canonical authored data merely because
        // its source appears later. This mirrors the same-source collision
        // rule while preserving ordinary later-source overlay semantics for
        // canonical/canonical and projection/projection pairs.
        mergeEvents.push({
          level: "warning",
          sourceId: write.source.id,
          message: `worldData projection ${identity} from source "${write.source.id}" was skipped because canonical source "${existing.source.id}" owns the same target/key`,
        });
        continue;
      }
      mergeEvents.push({
        level: "warning",
        sourceId: write.source.id,
        message: `worldData ${identity} from source "${write.source.id}" replaces ${existingProjection && !currentProjection ? "projected " : ""}source "${existing.source.id}"`,
      });
      const index = merged.indexOf(existing);
      if (index >= 0) merged[index] = write;
      byIdentity.set(identity, write);
    }
  }

  return {
    writes: merged,
    diagnostics,
    mergeEvents,
    deferredProjectionOutputs,
  };
}
