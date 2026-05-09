import type { PluginRegistryEntry } from "@covel/plugin-loader";
import {
  parsePluginSchemaUri,
  pluginSchemaUriForTarget,
  resolveWorldDataSchema,
  validateWorldDataSchemaValue,
  type WorldDataSchemaRef,
} from "../schema-registry.js";
import type { ParsedWorldDataTarget } from "../target-uri.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import { isRecord } from "./utils.js";
import type {
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";

function getPreflightPluginEntry(
  deps: WorldDataImportPreflightDeps | undefined,
  pluginId: string,
): PluginRegistryEntry | undefined {
  return deps?.getPluginEntry?.(pluginId) ?? deps?.registry?.get(pluginId);
}

export function preflightPluginTarget(
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

export async function validatePluginDataValue(options: {
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

export function pluginSchemaTargetCompatibilityDiagnostic(
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

export function validateSourceSchemaValues(options: {
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

export function lorebookPosition(value: Record<string, unknown>): string {
  if (typeof value.position === "string") return value.position;
  const coordinate = value.coordinate;
  if (isRecord(coordinate) && typeof coordinate.position === "string") {
    return coordinate.position;
  }
  return "after_plugin";
}

export function lorebookStrategy(
  value: Record<string, unknown>,
): "constant" | "selective" {
  if (value.strategy === "selective") return "selective";
  if (value.kind === "triggered") return "selective";
  return "constant";
}
