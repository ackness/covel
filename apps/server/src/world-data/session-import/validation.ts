import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
} from "@covel/shared";
import type { PluginRegistryEntry } from "@covel/plugin-loader";
import { z } from "zod";
import {
  MAX_PLUGIN_DATA_VALUE_BYTES,
  pluginDataSizeBytes,
} from "@covel/runtime";
import {
  pluginSchemaUriForTarget,
  resolvePluginSchema,
  validateWorldDataSchemaValue,
  type WorldDataSchemaRef,
} from "../schema-registry.js";
import type { ResolvedWorldDataTarget } from "../contract-targets.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import { isRecord, recordLocation, type RecordLocation } from "./utils.js";
import type {
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";

function getPreflightPluginEntry(
  deps: WorldDataImportPreflightDeps | undefined,
  pluginId: string,
): PluginRegistryEntry | undefined {
  return deps?.registry?.get(pluginId);
}

/**
 * Authoring-error checks for a plugin target (registered, declared namespace,
 * accepts world data). Target-plugin *activeness* is not checked here — an
 * inactive target is a player-selection outcome, handled in `buildImportPlan`
 * as a warning + source skip, never an import-blocking error.
 */
export function preflightPluginTarget(
  target: PluginDataTarget,
  source: OrderedWorldDataSource,
  deps: WorldDataImportPreflightDeps | undefined,
): readonly WorldDataDiagnostic[] {
  const diagnostics: WorldDataDiagnostic[] = [];
  if (
    target.namespace === DIMENSION_DATA_NAMESPACE ||
    target.namespace === DIMENSION_SETTLEMENT_NAMESPACE
  )
    return [
      {
        level: "error",
        sourceId: source.id,
        message:
          "Protected dimension data must be authored through world:metadata.dimensions, not plugin-data targets",
      },
    ];
  const entry = getPreflightPluginEntry(deps, target.pluginId);
  if (deps?.registry) {
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
  /** The record of the source that `value` is, when it is one. */
  readonly record?: RecordLocation;
}): Promise<WorldDataDiagnostic | null> {
  const bytes = pluginDataSizeBytes(options.value);
  if (bytes > MAX_PLUGIN_DATA_VALUE_BYTES) {
    const where = options.record
      ? `${options.record.label} of source "${options.source.id}"`
      : `worldData source "${options.source.id}" value`;
    return {
      level: "error",
      sourceId: options.source.id,
      message: `${where} is ${bytes} bytes, over the ${MAX_PLUGIN_DATA_VALUE_BYTES}-byte limit for one plugin-data value (plugin "${options.target.pluginId}" namespace "${options.target.namespace}")`,
      hint: "Split the record into several records, or drop what no turn reads.",
    };
  }
  const schema =
    options.schema?.kind === "plugin" &&
    options.schema.pluginId === options.target.pluginId &&
    options.schema.namespace === options.target.namespace
      ? options.schema
      : await resolvePluginSchema(
          pluginSchemaUriForTarget(options.target),
          options.target.pluginId,
          options.target.namespace,
          options.deps,
        );
  if (!schema || "level" in schema) return schema;
  const receiver = `plugin "${options.target.pluginId}" namespace "${options.target.namespace}"`;
  return validateWorldDataSchemaValue({
    schema,
    source: options.source,
    value: options.value,
    label: options.record
      ? `${options.record.label} of source "${options.source.id}", for ${receiver},`
      : `worldData value for ${receiver}`,
    at: options.record,
  });
}

/** Whether the source schema checks each record of a list, or the file as one value. */
function validatesEachRecord(
  source: OrderedWorldDataSource,
  value: unknown,
): value is readonly unknown[] {
  return (
    Boolean(source.descriptor.key) &&
    Array.isArray(value) &&
    source.descriptor.schema !== "covel://world/dimensions"
  );
}

export function validateSourceSchemaValues(options: {
  readonly source: OrderedWorldDataSource;
  readonly schema: WorldDataSchemaRef | null;
  readonly target?: ResolvedWorldDataTarget;
  readonly value: unknown;
}): readonly WorldDataDiagnostic[] {
  if (!options.schema) return [];
  if (
    options.schema.kind === "plugin" &&
    options.target?.kind === "plugin-data" &&
    options.schema.pluginId === options.target.pluginId &&
    options.schema.namespace === options.target.namespace
  ) {
    return [];
  }
  if (options.source.descriptor.kind === "media") return [];
  const listed = validatesEachRecord(options.source, options.value);
  const diagnostics: WorldDataDiagnostic[] = [];
  // Each record that fails gets its own diagnostic: the author has to find
  // every one of them, and two records often fail in the same way.
  for (const [index, value] of (listed
    ? options.value
    : [options.value]
  ).entries()) {
    const record = recordLocation(options.source, value, index, listed);
    const validation = validateWorldDataSchemaValue({
      schema: options.schema,
      source: options.source,
      value,
      label: listed
        ? `${record.label} of source "${options.source.id}"`
        : `worldData source "${options.source.id}" value`,
      at: record,
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

const lorebookPositionSchema = z.enum([
  "before_plugin",
  "after_plugin",
  "at_depth",
]);

/** All stores accept finite fractional ordering values. */
const insertionOrderSchema = z.number().finite();

/**
 * A record of a `to: lorebook` source: its text, and the fields that say when
 * and where the entry is injected. Other values belong under `extra`.
 */
const lorebookRecordSchema = z.looseObject({
  content: z
    .string()
    .refine((text) => text.trim().length > 0, "must not be empty"),
  title: z.string().optional(),
  strategy: z.enum(["constant", "selective"]).optional(),
  kind: z.enum(["constant", "triggered"]).optional(),
  keys: z.array(z.string()).optional(),
  position: lorebookPositionSchema.optional(),
  coordinate: z
    .looseObject({ position: lorebookPositionSchema.optional() })
    .optional(),
  insertionOrder: insertionOrderSchema.optional(),
  enabled: z.boolean().optional(),
  extra: z
    .looseObject({ scanDepth: z.number().int().min(0).max(20).optional() })
    .optional(),
});

const LOREBOOK_RECORD_FIELDS = [
  ...Object.keys(lorebookRecordSchema.shape),
  "extra",
];

function quoted(fields: readonly string[]): string {
  return fields.map((field) => `\`${field}\``).join(", ");
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `\`${issue.path.join(".") || "(record)"}\`: ${issue.message}`,
  );
}

/**
 * A selective entry is injected when the player's message holds one of its
 * keys. Without a key it is never injected, and nothing else says so.
 */
function selectiveWithoutKey(value: Record<string, unknown>): boolean {
  return (
    lorebookStrategy(value) === "selective" &&
    !(
      Array.isArray(value.keys) &&
      value.keys.some((key) => typeof key === "string" && key.trim().length > 0)
    )
  );
}

const SELECTIVE_WITHOUT_KEY =
  "it is selective (`strategy: selective` or `kind: triggered`) and has no key, so it would never be injected";
const SELECTIVE_HINT =
  "Give the entry `keys` with at least one word that a player message can hold, or make it `strategy: constant` to inject it every turn.";

export interface LorebookRecordCheck {
  /** Why the record cannot become a lorebook entry; empty when it can. */
  readonly errors: readonly string[];
  /** What the record holds that the importer does not read. */
  readonly warnings: readonly string[];
  /** What to change, for the first of the findings. */
  readonly hint?: string;
}

/**
 * Check one value of a `to: lorebook` source. A text is an entry as it is. A
 * record needs `content`: one without it would be imported with its whole
 * JSON as the text of the entry, and injected like that every turn.
 */
export function checkLorebookRecord(
  value: unknown,
  keyField: string | undefined,
): LorebookRecordCheck {
  if (typeof value === "string")
    return value.trim().length > 0
      ? { errors: [], warnings: [] }
      : { errors: ["its text is empty"], warnings: [] };
  if (!isRecord(value))
    return {
      errors: ["it must be a mapping with `content`"],
      warnings: [],
      hint: "Write each entry as `- id: <name>` followed by `content: <text>`.",
    };
  const unread = Object.keys(value).filter(
    (field) => field !== keyField && !LOREBOOK_RECORD_FIELDS.includes(field),
  );
  const parsed = lorebookRecordSchema.safeParse(value);
  const errors = parsed.success ? [] : issueLines(parsed.error);
  if (selectiveWithoutKey(value)) errors.push(SELECTIVE_WITHOUT_KEY);

  if (errors.length === 0)
    return unread.length === 0
      ? { errors, warnings: [] }
      : {
          errors,
          warnings: [
            `${quoted(unread)} ${unread.length === 1 ? "is not a lorebook field and is" : "are not lorebook fields and are"} not imported`,
          ],
          hint: `A lorebook record has ${quoted(LOREBOOK_RECORD_FIELDS)}. Put other values under \`extra\`.`,
        };
  let hint =
    "A lorebook record has `content` (text), and may have `strategy` (constant or selective), `keys` (a list of words), `position` (before_plugin, after_plugin or at_depth), `insertionOrder` (a finite number) and `enabled` (true or false).";
  // A misspelled field is the usual reason for a missing one.
  if (typeof value.content !== "string" && unread.length > 0)
    hint = `The text of an entry is in \`content\`. This record has ${quoted(unread)}, which the importer does not read.`;
  else if (parsed.success) hint = SELECTIVE_HINT;
  return { errors, warnings: [], hint };
}

/**
 * Check the lorebook entry that a `+lorebook` destination makes of a contract
 * record. The shape of the record is the contract's; only what the entry is
 * built from is checked here.
 */
export function checkProjectedLorebookRecord(
  value: unknown,
): LorebookRecordCheck {
  if (!isRecord(value)) return { errors: [], warnings: [] };
  const errors: string[] = [];
  let hint: string | undefined;
  if (
    typeof value.insertionOrder === "number" &&
    !insertionOrderSchema.safeParse(value.insertionOrder).success
  ) {
    errors.push(
      `\`insertionOrder\` is ${value.insertionOrder}; the lorebook needs a finite number`,
    );
    hint =
      "Write `insertionOrder` as a finite number: entries are injected in ascending order of it.";
  }
  if (selectiveWithoutKey(value)) {
    errors.push(SELECTIVE_WITHOUT_KEY);
    hint ??= SELECTIVE_HINT;
  }
  return { errors, warnings: [], ...(hint ? { hint } : {}) };
}
