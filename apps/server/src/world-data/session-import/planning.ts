import { isRecord } from "../../lib/is-record.js";
import {
  resolveWorldDataTargets,
  type ResolvedWorldDataTarget,
} from "../contract-targets.js";
import path from "node:path";
import {
  hiddenPluginDataNamespace,
  characterSchemaSetPayloadSchema,
  KERNEL_CHARACTER_FIELDS,
  validateWorldModel,
  worldDimensionsSchema,
  type CharacterSchemaRecord,
  type WorldDimensions,
  parseWorldDataIndexTarget,
  parseWorldDataTarget,
} from "@covel/shared";
import type { CharacterRecord } from "@covel/store";
import { ZodError } from "zod";
import { canonicalJson, digestFile, sha256Hex } from "../digest.js";
import { collectMediaSourceFiles } from "../media.js";
import { checkRecordDimensionReferences } from "../record-checks.js";
import { readWorldDataSource } from "../source-reader.js";
import { characterRecordFromValue } from "../character-effects.js";
import {
  characterBlockRoutes,
  type CharacterBlockRoute,
} from "../conventions.js";
import {
  resolveWorldDataSchema,
  type WorldDataSchemaRef,
} from "../schema-registry.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import {
  pluginWriteIdentity,
  sameSourceDuplicateIdentity,
} from "./identity.js";
import { mediaMime } from "./media-handling.js";
import {
  executeWorldProjections,
  hasActiveWorldProjections,
} from "./projections.js";
import type {
  ImportPlan,
  MergeEvent,
  PlannedWrite,
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";
import { recordLocation, sourceItems, type RecordLocation } from "./utils.js";
import {
  checkLorebookRecord,
  checkProjectedLorebookRecord,
  type LorebookRecordCheck,
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

/** A field of character records and the active namespaces its records go to. */
interface CharacterBlockTargets extends CharacterBlockRoute {
  readonly targets: readonly PluginDataTarget[];
}

/** What a character source needs to hand the plugin data its records carry. */
interface CharacterBlocks {
  readonly routes: readonly CharacterBlockTargets[];
  /** Fields that more than one contract names: read for none of them. */
  readonly colliding: readonly string[];
  /** Report a field no plugin reads: an authoring check of every plugin. */
  readonly reportUnread: boolean;
}

/**
 * The plugin data one character record carries. Each field a plugin names
 * (`authoring.characterField`) holds one record of that plugin's data
 * contract, keyed by the character's id, and goes to every active namespace
 * that accepts the contract. A record that fails the receiver's schema is
 * reported and left out; the character is imported either way.
 */
async function appendCharacterBlocks(options: {
  writes: PlannedWrite[];
  diagnostics: WorldDataDiagnostic[];
  source: OrderedWorldDataSource;
  sourceDigest: string;
  characterId: string;
  value: Record<string, unknown>;
  location: RecordLocation;
  blocks: CharacterBlocks;
  deps?: WorldDataImportPreflightDeps;
  dimensions?: WorldDimensions;
}): Promise<void> {
  const { source, location, blocks } = options;
  const at = (field: string): RecordLocation => ({
    label: `${location.label} field "${field}"`,
    ...(location.path ? { path: location.path } : {}),
    pointer: location.pointer ? `${location.pointer}.${field}` : field,
  });
  for (const route of blocks.routes) {
    const block = options.value[route.field];
    if (block === undefined) continue;
    const where = at(route.field);
    const catalogue = options.deps?.registry;
    const findings =
      catalogue && options.dimensions
        ? checkRecordDimensionReferences({
            record: block,
            contract: route.contract,
            catalogue,
            dimensions: options.dimensions,
            pointer: where.pointer ?? "",
            pluginIds: route.targets.map((target) => target.pluginId),
          })
        : [];
    if (findings.length > 0) {
      options.diagnostics.push(
        ...findings.map((finding) => ({
          level: "error" as const,
          code: "dimension-reference" as const,
          sourceId: source.id,
          ...(where.path ? { path: where.path } : {}),
          ...finding,
        })),
      );
      continue;
    }
    for (const target of route.targets) {
      const error = await validatePluginDataValue({
        target,
        source,
        value: block,
        deps: options.deps,
        record: where,
      });
      if (error) {
        options.diagnostics.push(error);
        continue;
      }
      options.writes.push({
        kind: "plugin-data",
        target: `contract:${route.contract}`,
        source,
        sourceDigest: options.sourceDigest,
        pluginId: target.pluginId,
        namespace: target.namespace,
        key: options.characterId,
        value: block,
        derivedFrom: [options.characterId],
      });
    }
  }
  if (!blocks.reportUnread) return;
  const known = new Set<string>([
    ...KERNEL_CHARACTER_FIELDS,
    ...blocks.routes.map((route) => route.field),
    ...blocks.colliding,
  ]);
  for (const field of Object.keys(options.value)) {
    if (known.has(field)) continue;
    const where = at(field);
    options.diagnostics.push({
      level: "warning",
      sourceId: source.id,
      ...(where.path ? { path: where.path } : {}),
      ...(where.pointer ? { pointer: where.pointer } : {}),
      message: `${where.label} of source "${source.id}" is read by no plugin`,
      hint: "A character record holds `id`, `name`, `aliases`, `type`, `description` and `fields`, and a field a plugin names for its data (`pnpm describe:authoring` lists them as `characterField`). Remove the field or correct its name.",
    });
  }
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
  characterSchema: CharacterSchemaRecord | null;
  characterBlocks: CharacterBlocks;
  dimensions?: WorldDimensions;
}): Promise<void> {
  const { source, target } = options;
  if (target.kind === "world-metadata" || target.kind === "media") return;
  // The place of the next character among those this import has planned:
  // the roster lists them in this order.
  const characterOrder = () =>
    options.writes.filter((write) => write.kind === "character").length;
  for (const [index, value] of sourceItems(options.value).entries()) {
    const location = recordLocation(
      source,
      value,
      index,
      Array.isArray(options.value),
    );
    const report = (
      level: "error" | "warning",
      message: string,
      hint?: string,
    ) => {
      options.diagnostics.push({
        level,
        sourceId: source.id,
        path: location.path,
        pointer: location.pointer,
        message: `${location.label} of source "${source.id}": ${message}`,
        ...(hint ? { hint } : {}),
      });
    };
    const validateLorebook = (check: LorebookRecordCheck) => {
      for (const message of check.errors) report("error", message, check.hint);
      for (const message of check.warnings)
        report("warning", message, check.hint);
      return check.errors.length === 0;
    };
    const validateCharacter = (record: CharacterRecord | null) => {
      if (!record) {
        report(
          "error",
          "item cannot become a character record",
          "Provide non-empty id and name fields.",
        );
        return false;
      }
      try {
        // With the characters planned before it: an alias that an earlier
        // character has as a name or alias is reported at this record. It
        // is checked first, so the message is about it.
        validateWorldModel({
          characterSchema: options.characterSchema,
          characters: [
            record,
            ...options.writes.flatMap((write) =>
              write.kind === "character" && write.record.id !== record.id
                ? [write.record]
                : [],
            ),
          ],
          dimensions: {},
        });
        return true;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const message =
          error instanceof ZodError
            ? error.issues
                .map(
                  (issue) => `fields.${issue.path.join(".")}: ${issue.message}`,
                )
                .join("; ")
            : error.message;
        report(
          "error",
          message,
          message.startsWith("Alias ")
            ? "Give each name and alias to one character only."
            : "Match the character type and fields to world.yaml characterSchema.",
        );
        return false;
      }
    };
    const key = itemKey(source, value);
    if (!key) {
      report(
        "error",
        `needs a resolvable key for target ${source.descriptor.to}`,
        `Set the source's key field on this record (${source.descriptor.key ?? "key is missing"}).`,
      );
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
        record: location,
      });
      if (validationError) {
        options.diagnostics.push(validationError);
        continue;
      }
      const hidden = source.descriptor.visibility === "hidden";
      if (
        !hidden &&
        target.lorebook &&
        options.includeKernelEffects !== false &&
        !validateLorebook(checkProjectedLorebookRecord(value))
      )
        continue;
      options.writes.push({
        kind: "plugin-data",
        target: source.descriptor.to,
        source,
        sourceDigest: options.sourceDigest,
        pluginId: target.pluginId,
        namespace: hidden
          ? hiddenPluginDataNamespace(target.namespace)
          : target.namespace,
        key,
        value: pluginValue,
      });
      if (
        !hidden &&
        target.lorebook &&
        options.includeKernelEffects !== false
      ) {
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
      if (!validateLorebook(checkLorebookRecord(value, source.descriptor.key)))
        continue;
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
        characterOrder(),
      );
      if (!validateCharacter(record) || !record) continue;
      options.writes.push({
        kind: "character",
        target: source.descriptor.to,
        source,
        sourceDigest: options.sourceDigest,
        key: record.id,
        record,
        value,
      });
      if (isRecord(value))
        await appendCharacterBlocks({
          writes: options.writes,
          diagnostics: options.diagnostics,
          source,
          sourceDigest: options.sourceDigest,
          characterId: record.id,
          value,
          location,
          blocks: options.characterBlocks,
          deps: options.deps,
          dimensions: options.dimensions,
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
        characterOrder(),
      );
      if (!validateCharacter(character) || !character) continue;
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

/**
 * Hidden world data may only feed a plugin-data contract: it must never be
 * projected into the lorebook, character records, world metadata, or media,
 * because every one of those is visible to prompts or players.
 */
function hiddenSourceError(
  source: OrderedWorldDataSource,
  target: NonNullable<ReturnType<typeof parseWorldDataTarget>>,
): string | null {
  if (target.kind !== "contract-data")
    return `hidden source "${source.id}" must target a data contract (contract:<id>), not ${source.descriptor.to}`;
  if (target.lorebook)
    return `hidden source "${source.id}" cannot project into the lorebook (+lorebook)`;
  if (source.descriptor.kind === "media" || source.descriptor.indexTo)
    return `hidden source "${source.id}" cannot be a media source or declare indexTo`;
  return null;
}

/**
 * The plugin data fields of character records for this import: the fields
 * the active plugins name, with the namespaces that receive each. Without a
 * registry no plugin is known and the records are characters only.
 */
function resolveCharacterBlocks(
  sources: readonly OrderedWorldDataSource[],
  deps: WorldDataImportPreflightDeps | undefined,
  diagnostics: WorldDataDiagnostic[],
): CharacterBlocks {
  const characterSource = sources.find(
    (source) =>
      parseWorldDataTarget(source.descriptor.to)?.kind === "characters",
  );
  if (!characterSource || !deps?.registry)
    return { routes: [], colliding: [], reportUnread: false };
  const { routes, collisions } = characterBlockRoutes(
    deps.registry,
    deps.activePlugins,
  );
  for (const collision of collisions)
    diagnostics.push({
      level: "warning",
      sourceId: characterSource.id,
      message: `the "${collision.field}" field of character records is not imported: more than one plugin names it for its data (${collision.claimants.join(", ")})`,
      hint: "Turn off all but one of these plugins.",
    });
  return {
    routes: routes.map((route) => {
      const targets = resolveWorldDataTargets(
        { kind: "contract-data", contract: route.contract, lorebook: false },
        deps,
        characterSource.id,
        diagnostics,
      ).filter(isPluginTarget);
      for (const target of targets)
        diagnostics.push(
          ...preflightPluginTarget(target, characterSource, deps),
        );
      return { ...route, targets };
    }),
    colliding: collisions.map((collision) => collision.field),
    // Only a check of the whole catalogue knows that no plugin reads a field.
    reportUnread: deps.activePlugins === undefined,
  };
}

function isProjectionWrite(write: PlannedWrite): boolean {
  return (
    write.derivedFrom?.some((item) => item.startsWith("projection:")) ?? false
  );
}

export async function buildImportPlan(options: {
  sessionId: string;
  worldId: string;
  sources: readonly OrderedWorldDataSource[];
  deps?: WorldDataImportPreflightDeps;
  now: string;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  locale?: string;
  characterSchema?: unknown;
  dimensions?: unknown;
}): Promise<ImportPlan> {
  // Dimension declaration errors are reported by appendDimensionPlan.
  const dimensions = worldDimensionsSchema.safeParse(options.dimensions ?? {});
  const writes: PlannedWrite[] = [];
  const diagnostics: WorldDataDiagnostic[] = [];
  const unreceivedSources = new Set<string>();
  const deferredSources: NonNullable<ImportPlan["deferredSources"]>[number][] =
    [];
  let characterSchema: CharacterSchemaRecord | null = null;
  if (options.characterSchema !== undefined) {
    const parsed = characterSchemaSetPayloadSchema.safeParse(
      options.characterSchema,
    );
    if (!parsed.success) {
      return {
        writes: [],
        mergeEvents: [],
        deferredProjectionOutputs: [],
        diagnostics: [
          {
            level: "error",
            path: "world.yaml",
            pointer: "characterSchema",
            message: `Invalid characterSchema: ${parsed.error.message}`,
            hint: "Use the current world characterSchema contract.",
          },
        ],
      };
    }
    characterSchema = {
      ...parsed.data,
      version: 1,
      sessionId: options.sessionId,
      createdAt: options.now,
      updatedAt: options.now,
    };
  }
  const deferredProjectionOutputs: ImportPlan["deferredProjectionOutputs"][number][] =
    [];
  const characterBlocks = resolveCharacterBlocks(
    options.sources,
    options.deps,
    diagnostics,
  );

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
    if (source.descriptor.visibility === "hidden") {
      const hiddenError = hiddenSourceError(source, parsedTarget);
      if (hiddenError) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: hiddenError,
        });
        continue;
      }
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
    if (source.descriptor.indexTo && !parsedIndex) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        message: `invalid indexTo URI: ${source.descriptor.indexTo}`,
      });
    }
    const indexTargets = parsedIndex
      ? resolveWorldDataTargets(
          parsedIndex,
          options.deps,
          source.id,
          diagnostics,
        ).filter(isPluginTarget)
      : [];
    // Direct receivers and projection consumers are independent. Only skip
    // schema/file reads when neither can consume this source; author validation
    // checks sources separately. Sync must distinguish this from an empty source.
    if (
      (parsedTarget.kind === "contract-data" && targets.length === 0) ||
      (parsedIndex && indexTargets.length === 0)
    ) {
      unreceivedSources.add(source.id);
      const hasProjections = hasActiveWorldProjections({
        source,
        deps: options.deps,
      });
      deferredSources.push({
        sourceId: source.id,
        scope: hasProjections ? "primary" : "all",
      });
      if (!hasProjections) continue;
    }
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
    const resolvedSchema = await resolveWorldDataSchema({
      source,
      deps: options.deps,
    });
    if (resolvedSchema && "level" in resolvedSchema) {
      diagnostics.push({ sourceId: source.id, ...resolvedSchema });
      continue;
    }

    const read =
      source.inlineValue !== undefined
        ? { value: source.inlineValue, path: undefined, diagnostics: [] }
        : await readWorldDataSource(source, options.locale);
    diagnostics.push(...read.diagnostics);
    if (read.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      continue;
    }
    if (!read.path && source.inlineValue === undefined) continue;

    const mediaFiles =
      source.descriptor.kind === "media"
        ? await collectMediaSourceFiles(source, read.path!)
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

    const catalogue = options.deps?.registry;
    if (
      parsedTarget.kind === "contract-data" &&
      catalogue &&
      dimensions.success
    ) {
      const findings = sourceItems(read.value).flatMap((record, index) =>
        checkRecordDimensionReferences({
          record,
          contract: parsedTarget.contract,
          catalogue,
          dimensions: dimensions.data,
          pointer:
            recordLocation(source, record, index, Array.isArray(read.value))
              .pointer ?? "",
          pluginIds: targets
            .filter(isPluginTarget)
            .map((target) => target.pluginId),
        }),
      );
      diagnostics.push(
        ...findings.map((finding) => ({
          level: "error" as const,
          code: "dimension-reference" as const,
          sourceId: source.id,
          path: read.path
            ? path.relative(source.pathOrigin.descriptorRoot, read.path)
            : undefined,
          ...finding,
        })),
      );
      if (findings.length) continue;
    }

    const sourceDigest =
      source.descriptor.kind === "media"
        ? (mediaFiles?.digest ?? sha256Hex(""))
        : source.inlineValue !== undefined
          ? sha256Hex(canonicalJson(source.inlineValue))
          : (await digestFile(read.path!)).digest;

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
        characterSchema,
        characterBlocks,
        ...(dimensions.success ? { dimensions: dimensions.data } : {}),
      });
    }

    // Projections derive lorebook/plugin rows from source values, so they
    // would republish hidden data; hidden sources skip them entirely.
    if (source.descriptor.visibility === "hidden") continue;
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

  for (const source of options.sources) {
    // Metadata is applied by world loading; projections may be deferred in
    // a static preflight. Neither implies a broken session-data source.
    if (parseWorldDataTarget(source.descriptor.to)?.kind === "world-metadata")
      continue;
    if (
      unreceivedSources.has(source.id) ||
      writes.some((write) => write.source.id === source.id) ||
      deferredProjectionOutputs.some(
        (output) => output.sourceId === source.id,
      ) ||
      diagnostics.some(
        (diagnostic) =>
          diagnostic.sourceId === source.id && diagnostic.level === "error",
      )
    )
      continue;
    diagnostics.push({
      level: "warning",
      sourceId: source.id,
      path: source.descriptor.path,
      message: `source "${source.id}" produces no session records`,
      hint: "Check that the source has records and an active plugin accepts its target contract.",
    });
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
      const existingProjection = isProjectionWrite(existing.write);
      const currentProjection = isProjectionWrite(write);
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
      const existingProjection = isProjectionWrite(existing);
      const currentProjection = isProjectionWrite(write);
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
    deferredSources,
  };
}
