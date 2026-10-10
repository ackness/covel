import { z } from "zod";
import type { JsonValue } from "./types.js";
import type {
  DimensionRecord,
  DimensionSnapshot,
  DimensionValueSchema,
  DimensionValueType,
  WorldDimensionDefinition,
  WorldDimensions,
} from "./dimension-types.js";
import { resolveI18nText } from "./i18n.js";

export const DIMENSION_DATA_NAMESPACE = "_dimensions";
export const DIMENSION_SETTLEMENT_NAMESPACE = "_dimension-settlements";
export const DIMENSION_CONTRACT = "world.dimensions@1";
export const DIMENSION_MAX_DEPTH = 32;
export const DIMENSION_MAX_NODES = 10000;
export const DIMENSION_MAX_BYTES = 262144;
export const DIMENSION_MAX_UPDATES = 64;

export const dimensionIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/)
  .refine((id) => !["__proto__", "prototype", "constructor"].includes(id), {
    message: "Unsafe dimension ID",
  });

/** Check bounds before recursive schemas or JSON serialization touch external data. */
export function dimensionJsonError(value: unknown): string | undefined {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): string | undefined {
    if (++nodes > DIMENSION_MAX_NODES) return "JSON node limit exceeded";
    if (depth > DIMENSION_MAX_DEPTH) return "JSON depth limit exceeded";
    if (input === null || typeof input === "boolean") return;
    if (typeof input === "number") {
      return Number.isFinite(input) ? undefined : "JSON numbers must be finite";
    }
    if (typeof input === "string") {
      return input.length <= DIMENSION_MAX_BYTES
        ? undefined
        : "JSON size limit exceeded";
    }
    if (typeof input !== "object") return "Expected a JSON value";
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    ) {
      return "Expected a plain JSON object";
    }
    if (ancestors.has(input)) return "Cyclic JSON value";
    ancestors.add(input);
    if (Object.getOwnPropertySymbols(input).length > 0)
      return "JSON symbol keys are not supported";
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Object.values(descriptors).some(
        (descriptor) => descriptor.get || descriptor.set,
      )
    ) {
      return "JSON accessors are not supported";
    }
    const children = Array.isArray(input) ? input : Object.values(input);
    for (const child of children) {
      const error = visit(child, depth + 1);
      if (error) return error;
    }
    ancestors.delete(input);
  }
  const error = visit(value, 0);
  if (error) return error;
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    DIMENSION_MAX_BYTES
  ) {
    return "JSON size limit exceeded";
  }
}

export const dimensionJsonSchema = z.custom<JsonValue>(
  (value) => dimensionJsonError(value) === undefined,
  { message: "Expected bounded, finite, acyclic JSON" },
);

const textSchema = z.union([z.string(), z.record(z.string(), z.string())]);
const valueTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
]);
const countSchema = z.number().int().nonnegative();

const recursiveValueSchema: z.ZodType<DimensionValueSchema> = z.lazy(() =>
  z
    .strictObject({
      type: z
        .union([
          valueTypeSchema,
          z
            .array(valueTypeSchema)
            .min(1)
            .refine((types) => new Set(types).size === types.length),
        ])
        .describe(
          "JSON type of the value, or a list of types for a nullable value.",
        )
        .optional(),
      title: textSchema.describe("Display label of this node.").optional(),
      description: z
        .string()
        .describe("What this node holds. Given to the model.")
        .optional(),
      enum: z
        .array(dimensionJsonSchema)
        .min(1)
        .describe("Allowed values.")
        .optional(),
      const: dimensionJsonSchema.describe("The only allowed value.").optional(),
      minimum: z.number().describe("Inclusive lower bound.").optional(),
      maximum: z.number().describe("Inclusive upper bound.").optional(),
      exclusiveMinimum: z
        .number()
        .describe("Exclusive lower bound.")
        .optional(),
      exclusiveMaximum: z
        .number()
        .describe("Exclusive upper bound.")
        .optional(),
      minLength: countSchema
        .describe("Minimum string length in characters.")
        .optional(),
      maxLength: countSchema
        .describe("Maximum string length in characters.")
        .optional(),
      // Describe the optional wrapper, never the recursive reference itself:
      // `.describe()` clones its receiver, and a fresh lazy on every
      // evaluation would make schema traversal recurse without end.
      items: recursiveValueSchema
        .optional()
        .describe("Schema of every array element."),
      minItems: countSchema.describe("Minimum array length.").optional(),
      maxItems: countSchema.describe("Maximum array length.").optional(),
      properties: z
        .record(z.string(), recursiveValueSchema)
        .describe("Schemas of the named properties of an object.")
        .optional(),
      required: z
        .array(z.string())
        .refine((keys) => new Set(keys).size === keys.length)
        .describe(
          "Property names that must be present. Each must be declared in `properties`.",
        )
        .optional(),
      additionalProperties: z
        .union([z.boolean(), recursiveValueSchema])
        .describe(
          "`false` rejects undeclared keys. A schema describes dynamically named records.",
        )
        .optional(),
      "x-i18n": z
        .boolean()
        .describe(
          "Marks this node as translatable text: its value is a string written in the file's own language; translations go in the locale edition of the file. Nodes without it are never localized.",
        )
        .optional(),
      "x-enumLabels": z
        .record(z.string(), textSchema)
        .describe(
          "Display labels keyed by enum member. A label never replaces the stored value.",
        )
        .optional(),
    })
    .superRefine((node, ctx) => {
      const labels = node["x-enumLabels"];
      if (!labels) return;
      // Display labels only: every key must name a scalar enum member, so a
      // label can never stand in for a value the schema would reject.
      const members = new Set(
        (node.enum ?? [])
          .filter((item) => item === null || typeof item !== "object")
          .map(String),
      );
      for (const key of Object.keys(labels))
        if (!members.has(key))
          ctx.addIssue({
            code: "custom",
            path: ["x-enumLabels", key],
            message: "x-enumLabels keys must be scalar enum members",
          });
    }),
);

function boundedDimensionInput(value: unknown, ctx: z.RefinementCtx): unknown {
  const error = dimensionJsonError(value);
  if (error) {
    ctx.addIssue({ code: "custom", message: error });
    return z.NEVER;
  }
  return value;
}

// Reject structurally unsatisfiable nodes: a `required` key that is not
// declared in `properties` can never be satisfied under
// `additionalProperties: false`, and silently does nothing otherwise.
// `required` is only meaningful against `properties` in this subset.
const dimensionValueSchemaRefined = recursiveValueSchema.superRefine(
  (node, ctx) => {
    if (!node.required || node.required.length === 0) return;
    const declared = node.properties ? Object.keys(node.properties) : [];
    for (const key of node.required) {
      if (!declared.includes(key))
        ctx.addIssue({
          code: "custom",
          path: ["required"],
          message: `Required property "${key}" is not declared in properties`,
        });
    }
  },
);

export const dimensionValueSchema = z.preprocess(
  boundedDimensionInput,
  dimensionValueSchemaRefined,
);

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equalJson(
          (left as Record<string, JsonValue>)[key]!,
          (right as Record<string, JsonValue>)[key]!,
        ),
    )
  );
}

function matchesType(value: JsonValue, type: DimensionValueType): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

export interface DimensionValueIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface DimensionValueValidationOptions {
  /**
   * What an `x-i18n` node may hold. `authored` (the default) is a world
   * package before import: a plain string or a locale map. `resolved` is
   * session state, where the content locale is already fixed: a plain string
   * only.
   */
  readonly localized?: "authored" | "resolved";
}

/** No coercion, defaults, code execution or ignored schema keywords. */
export function validateDimensionValue(
  schema: DimensionValueSchema,
  value: unknown,
  options: DimensionValueValidationOptions = {},
): readonly DimensionValueIssue[] {
  const jsonError = dimensionJsonError(value);
  if (jsonError) return [{ path: [], message: jsonError }];
  const parsed = dimensionValueSchema.safeParse(schema);
  if (!parsed.success)
    return [{ path: [], message: "Unsupported dimension value schema" }];
  const issues: DimensionValueIssue[] = [];
  function visit(
    node: DimensionValueSchema,
    input: JsonValue,
    path: readonly (string | number)[],
  ): void {
    const add = (message: string) => {
      issues.push({ path, message });
    };
    if (node["x-i18n"]) {
      if (options.localized === "resolved" && typeof input !== "string") {
        add(
          "Expected a string. Write this text once, in the session language; do not supply a locale map",
        );
        return;
      }
      const text = textSchema.safeParse(input);
      if (!text.success) {
        add("Expected I18nText at an x-i18n node");
        return;
      }
      const plain = { ...node, "x-i18n": false };
      // Name the locale in the path so a model fixing its write knows which
      // translation broke the rule.
      if (typeof text.data === "string") visit(plain, text.data, path);
      else
        for (const [locale, translation] of Object.entries(text.data))
          visit(plain, translation, [...path, locale]);
      return;
    }
    const types =
      node.type === undefined
        ? undefined
        : typeof node.type === "string"
          ? [node.type]
          : node.type;
    if (types && !types.some((type) => matchesType(input, type))) {
      add(`Expected ${types.join(" | ")}`);
      return;
    }
    if (node.enum && !node.enum.some((item) => equalJson(item, input)))
      add("Value is not in enum");
    if (Object.hasOwn(node, "const") && !equalJson(node.const!, input))
      add("Value does not match const");
    if (typeof input === "number") {
      if (node.minimum !== undefined && input < node.minimum)
        add(`Minimum is ${node.minimum}`);
      if (node.maximum !== undefined && input > node.maximum)
        add(`Maximum is ${node.maximum}`);
      if (node.exclusiveMinimum !== undefined && input <= node.exclusiveMinimum)
        add(`Must exceed ${node.exclusiveMinimum}`);
      if (node.exclusiveMaximum !== undefined && input >= node.exclusiveMaximum)
        add(`Must be below ${node.exclusiveMaximum}`);
    }
    if (typeof input === "string") {
      const length = Array.from(input).length;
      if (node.minLength !== undefined && length < node.minLength)
        add(`Minimum length is ${node.minLength} (got ${length})`);
      // A model does not count characters: with the limit and the length
      // alone it cut 16 of 104. The amount to remove is a target it can use.
      if (node.maxLength !== undefined && length > node.maxLength)
        add(
          `Maximum length is ${node.maxLength} (got ${length}): remove at least ${length - node.maxLength} characters`,
        );
    }
    if (Array.isArray(input)) {
      if (node.minItems !== undefined && input.length < node.minItems)
        add(`Minimum items is ${node.minItems}`);
      if (node.maxItems !== undefined && input.length > node.maxItems)
        add(`Maximum items is ${node.maxItems}`);
      if (node.items)
        input.forEach((item, index) =>
          visit(node.items!, item, [...path, index]),
        );
    } else if (input !== null && typeof input === "object") {
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(input, key))
          issues.push({ path: [...path, key], message: "Required property" });
      }
      for (const [key, item] of Object.entries(input)) {
        const property =
          node.properties && Object.hasOwn(node.properties, key)
            ? node.properties[key]
            : undefined;
        if (property) visit(property, item, [...path, key]);
        else if (node.additionalProperties === false)
          issues.push({ path: [...path, key], message: "Unknown property" });
        else if (typeof node.additionalProperties === "object")
          visit(node.additionalProperties, item, [...path, key]);
      }
    }
  }
  visit(parsed.data, value as JsonValue, []);
  return issues;
}

export const worldDimensionDefinitionSchema: z.ZodType<WorldDimensionDefinition> =
  z
    .strictObject({
      name: textSchema
        .refine(
          (name) =>
            (typeof name === "string" ? [name] : Object.values(name)).some(
              (text) => text.trim().length > 0,
            ),
          { message: "Dimension name must be non-empty" },
        )
        .describe("Display name of the dimension."),
      description: textSchema.describe("What the dimension tracks.").optional(),
      schema: dimensionValueSchema.describe(
        "Value schema in the supported JSON Schema subset. Unsupported keywords are rejected.",
      ),
      initialValue: dimensionJsonSchema.describe(
        "Starting value. It must satisfy `schema`.",
      ),
      updateRule: textSchema
        .describe(
          "Natural-language rule for how the value changes in play. When non-empty, the dimension tracker settles it after each turn. Omit it for static setting.",
        )
        .optional(),
    })
    .superRefine((definition, ctx) => {
      for (const issue of validateDimensionValue(
        definition.schema,
        definition.initialValue,
      )) {
        ctx.addIssue({
          code: "custom",
          path: ["initialValue", ...issue.path],
          message: issue.message,
        });
      }
    });

function boundedDimensionMapInput(
  value: unknown,
  ctx: z.RefinementCtx,
): unknown {
  const bounded = boundedDimensionInput(value, ctx);
  if (bounded === z.NEVER) return bounded;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!dimensionIdSchema.safeParse(key).success) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Invalid dimension ID",
        });
        return z.NEVER;
      }
    }
  }
  return value;
}

export const worldDimensionsSchema: z.ZodType<WorldDimensions> = z.preprocess(
  boundedDimensionMapInput,
  z.record(dimensionIdSchema, worldDimensionDefinitionSchema),
);

export const dimensionSourceSchema = z.strictObject({
  resultId: z.string().min(1),
  turnNumber: z.number().int().nonnegative(),
});

const dimensionRecordShape = z.strictObject({
  definition: worldDimensionDefinitionSchema,
  value: dimensionJsonSchema,
  version: z.number().int().positive(),
  lastTrackedSource: dimensionSourceSchema.optional(),
});

export const dimensionRecordSchema: z.ZodType<DimensionRecord> =
  dimensionRecordShape.superRefine((record, ctx) => {
    // A session holds one language. Locale maps are resolved when the world
    // is imported, so neither the value nor the stored definition has any.
    for (const [field, value] of [
      ["value", record.value],
      ["definition.initialValue", record.definition.initialValue],
    ] as const)
      for (const issue of validateDimensionValue(
        record.definition.schema,
        value,
        { localized: "resolved" },
      )) {
        ctx.addIssue({
          code: "custom",
          path: [...field.split("."), ...issue.path],
          message: issue.message,
        });
      }
    if (
      record.definition.updateRule !== undefined &&
      typeof record.definition.updateRule !== "string"
    )
      ctx.addIssue({
        code: "custom",
        path: ["definition", "updateRule"],
        message: "Expected a string in the session language",
      });
  });

const snapshotEntrySchema = z
  .strictObject({
    name: textSchema,
    description: textSchema.optional(),
    schema: dimensionValueSchema,
    value: dimensionJsonSchema,
    version: z.number().int().positive(),
  })
  .superRefine((entry, ctx) => {
    for (const issue of validateDimensionValue(entry.schema, entry.value, {
      localized: "resolved",
    })) {
      ctx.addIssue({
        code: "custom",
        path: ["value", ...issue.path],
        message: issue.message,
      });
    }
  });

export const dimensionSnapshotSchema: z.ZodType<DimensionSnapshot> =
  z.preprocess(
    boundedDimensionMapInput,
    z.record(dimensionIdSchema, snapshotEntrySchema),
  );
export const dimensionSettlementReceiptSchema = z.strictObject({
  source: dimensionSourceSchema,
  status: z.enum([
    "pending-settlement",
    "settled",
    "no-change",
    "manual",
    "skipped",
  ]),
  readVersions: z.record(dimensionIdSchema, z.number().int().positive()),
  definitions: worldDimensionsSchema,
  sourceTurnId: z.string().min(1),
  version: z.number().int().positive(),
  error: z.string().optional(),
  /** Why settlement is held back, for the host to test instead of reading `error`. */
  blockedBy: z.literal("extraction-failed").optional(),
});

export function dimensionSnapshotFromRecords(
  records: Readonly<Record<string, DimensionRecord>>,
): DimensionSnapshot {
  return Object.fromEntries(
    Object.entries(records).map(([id, { definition, value, version }]) => [
      id,
      {
        name: definition.name,
        ...(definition.description !== undefined
          ? { description: definition.description }
          : {}),
        schema: definition.schema,
        value: structuredClone(value),
        version,
      },
    ]),
  );
}

function localizeDimensionValue(
  schema: DimensionValueSchema,
  value: JsonValue,
  locale?: string,
): JsonValue {
  if (schema["x-i18n"])
    return (
      resolveI18nText(value as string | Record<string, string>, locale) ?? value
    );
  if (Array.isArray(value))
    return value.map((item) =>
      schema.items ? localizeDimensionValue(schema.items, item, locale) : item,
    );
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const child =
          schema.properties && Object.hasOwn(schema.properties, key)
            ? schema.properties[key]
            : typeof schema.additionalProperties === "object"
              ? schema.additionalProperties
              : undefined;
        return [
          key,
          child ? localizeDimensionValue(child, item, locale) : item,
        ];
      }),
    );
  }
  return value;
}

/**
 * Resolve an authored definition for one content locale: the initial value
 * and the update rule become plain strings. `name` and `description` are
 * labels, shown in the UI language, so they keep their locale maps.
 */
export function resolveDimensionDefinitionLocale(
  definition: WorldDimensionDefinition,
  locale?: string,
): WorldDimensionDefinition {
  const { updateRule, ...rest } = definition;
  const rule =
    updateRule === undefined
      ? undefined
      : (resolveI18nText(updateRule, locale) ?? "");
  return {
    ...rest,
    initialValue: localizeDimensionValue(
      definition.schema,
      definition.initialValue,
      locale,
    ),
    ...(rule === undefined ? {} : { updateRule: rule }),
  };
}

/** World dimensions as a session of this content locale stores them. */
export function resolveWorldDimensionsLocale(
  definitions: WorldDimensions,
  locale?: string,
): WorldDimensions {
  return Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      resolveDimensionDefinitionLocale(definition, locale),
    ]),
  );
}

/** Public recovery notice: no rules, initial values, baseline or narrative body. */
export const dimensionSettlementSummarySchema =
  dimensionSettlementReceiptSchema.pick({
    source: true,
    status: true,
    sourceTurnId: true,
    version: true,
    error: true,
  });
