import { z } from "zod";
import type { WorldIRJsonValue, WorldIRV1 } from "../types/world-ir.js";

export const WORLD_IR_V1_SCHEMA_URI = "covel://world/ir/v1" as const;

function deepFreezeSchema<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeSchema(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical JSON Schema for the public WorldIR v1 URI. Runtime output and
 * typed-input contracts resolve this object by URI instead of copying plugin-
 * local schemas that can silently drift apart.
 */
export const WORLD_IR_V1_JSON_SCHEMA = deepFreezeSchema({
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: WORLD_IR_V1_SCHEMA_URI,
  title: "Covel WorldIR v1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "entities", "relations", "events", "statements"],
  properties: {
    schemaVersion: { const: 1 },
    summary: { type: "string", minLength: 1 },
    entities: {
      type: "array",
      maxItems: 32,
      items: { $ref: "#/definitions/entity" },
    },
    relations: {
      type: "array",
      maxItems: 24,
      items: { $ref: "#/definitions/relation" },
    },
    events: {
      type: "array",
      maxItems: 32,
      items: { $ref: "#/definitions/event" },
    },
    statements: {
      type: "array",
      maxItems: 32,
      items: { $ref: "#/definitions/statement" },
    },
  },
  definitions: {
    attributes: { type: "object", additionalProperties: true },
    entity: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        attributes: { $ref: "#/definitions/attributes" },
      },
    },
    relation: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "from", "to"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        from: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        attributes: { $ref: "#/definitions/attributes" },
      },
    },
    event: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        participantIds: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1 },
        },
        time: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        attributes: { $ref: "#/definitions/attributes" },
      },
    },
    statement: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "content"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
        subjectIds: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1 },
        },
        attributes: { $ref: "#/definitions/attributes" },
      },
    },
  },
} as const);

const WORLD_IR_MAX_DEPTH = 32;
const WORLD_IR_MAX_NODES = 100_000;

export const worldIRJsonValueSchema: z.ZodType<WorldIRJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(worldIRJsonValueSchema),
    z.record(z.string(), worldIRJsonValueSchema),
  ]),
);

const worldIRAttributesSchema = z.record(z.string(), worldIRJsonValueSchema);
const worldIRIdSchema = z.string().min(1);
const worldIRTypeSchema = z.string().min(1);

export const worldIRV1EntitySchema = z
  .object({
    id: worldIRIdSchema,
    type: worldIRTypeSchema,
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    attributes: worldIRAttributesSchema.optional(),
  })
  .strict();

export const worldIRV1RelationSchema = z
  .object({
    id: worldIRIdSchema,
    type: worldIRTypeSchema,
    from: worldIRIdSchema,
    to: worldIRIdSchema,
    description: z.string().min(1).optional(),
    attributes: worldIRAttributesSchema.optional(),
  })
  .strict();

export const worldIRV1EventSchema = z
  .object({
    id: worldIRIdSchema,
    type: worldIRTypeSchema,
    participantIds: z.array(worldIRIdSchema).max(32).optional(),
    time: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    attributes: worldIRAttributesSchema.optional(),
  })
  .strict();

export const worldIRV1StatementSchema = z
  .object({
    id: worldIRIdSchema,
    type: worldIRTypeSchema,
    content: z.string().min(1),
    subjectIds: z.array(worldIRIdSchema).max(32).optional(),
    attributes: worldIRAttributesSchema.optional(),
  })
  .strict();

export const worldIRV1Schema: z.ZodType<WorldIRV1> = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1).optional(),
    entities: z.array(worldIRV1EntitySchema).max(32),
    relations: z.array(worldIRV1RelationSchema).max(24),
    events: z.array(worldIRV1EventSchema).max(32),
    statements: z.array(worldIRV1StatementSchema).max(32),
  })
  .strict();

export interface WorldIRV1ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type WorldIRV1ValidationResult =
  | { readonly valid: true; readonly data: WorldIRV1 }
  | {
      readonly valid: false;
      readonly errors: readonly WorldIRV1ValidationError[];
    };

function worldIRStructureErrors(
  value: unknown,
): readonly WorldIRV1ValidationError[] {
  if (value === null || typeof value !== "object") return [];
  const seen = new WeakSet<object>();
  const stack: Array<{ readonly value: object; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.value)) {
      return [
        {
          path: "(root)",
          message: "WorldIR must be an acyclic JSON value",
          code: "cycle",
        },
      ];
    }
    seen.add(current.value);
    nodes++;
    if (nodes > WORLD_IR_MAX_NODES) {
      return [
        {
          path: "(root)",
          message: `WorldIR exceeds the ${WORLD_IR_MAX_NODES} node limit`,
          code: "too_big",
        },
      ];
    }
    if (current.depth > WORLD_IR_MAX_DEPTH) {
      return [
        {
          path: "(root)",
          message: `WorldIR exceeds the maximum nesting depth of ${WORLD_IR_MAX_DEPTH}`,
          code: "too_deep",
        },
      ];
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return [];
}

function worldIRSemanticErrors(
  value: WorldIRV1,
): readonly WorldIRV1ValidationError[] {
  const errors: WorldIRV1ValidationError[] = [];
  const allIds = new Map<string, string>();
  const collections = [
    ["entities", value.entities],
    ["relations", value.relations],
    ["events", value.events],
    ["statements", value.statements],
  ] as const;
  for (const [collection, records] of collections) {
    records.forEach((record, index) => {
      const previous = allIds.get(record.id);
      if (previous) {
        errors.push({
          path: `${collection}.${index}.id`,
          message: `duplicate WorldIR id "${record.id}" (first declared at ${previous})`,
          code: "duplicate_id",
        });
      } else {
        allIds.set(record.id, `${collection}.${index}.id`);
      }
    });
  }

  const entityIds = new Set(value.entities.map((entity) => entity.id));
  const checkEntityRef = (id: string, path: string) => {
    if (!entityIds.has(id)) {
      errors.push({
        path,
        message: `entity reference "${id}" does not exist in entities`,
        code: "dangling_reference",
      });
    }
  };
  value.relations.forEach((relation, index) => {
    checkEntityRef(relation.from, `relations.${index}.from`);
    checkEntityRef(relation.to, `relations.${index}.to`);
  });
  value.events.forEach((event, eventIndex) => {
    event.participantIds?.forEach((id, index) =>
      checkEntityRef(id, `events.${eventIndex}.participantIds.${index}`),
    );
  });
  value.statements.forEach((statement, statementIndex) => {
    statement.subjectIds?.forEach((id, index) =>
      checkEntityRef(id, `statements.${statementIndex}.subjectIds.${index}`),
    );
  });
  return errors;
}

export function validateWorldIRV1(value: unknown): WorldIRV1ValidationResult {
  try {
    const structureErrors = worldIRStructureErrors(value);
    if (structureErrors.length > 0) {
      return { valid: false, errors: structureErrors };
    }
    const result = worldIRV1Schema.safeParse(value);
    if (result.success) {
      const semanticErrors = worldIRSemanticErrors(result.data);
      return semanticErrors.length === 0
        ? { valid: true, data: result.data }
        : { valid: false, errors: semanticErrors };
    }
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    };
  } catch (error) {
    // External/plugin values may be Proxies with throwing traps. Validation is
    // a trust boundary and must diagnose them instead of crashing a turn or
    // world import.
    return {
      valid: false,
      errors: [
        {
          path: "(root)",
          message: `WorldIR could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
          code: "inspection_failed",
        },
      ],
    };
  }
}

export const worldDataSourceIdRegex = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

export const worldDataSourceIdSchema = z
  .string()
  .regex(worldDataSourceIdRegex, {
    message:
      "source id must start with a letter and contain only letters, numbers, _ or -",
  });

export const worldDataSourceKindSchema = z.enum([
  "yaml",
  "json",
  "markdown",
  "text",
  "media",
]);

export const worldDataMergeModeSchema = z.enum(["replace", "skipExisting"]);

export const worldDataEffectSchema = z.enum(["characters", "projections"]);

const afterSchema = z.union([
  worldDataSourceIdSchema,
  z.array(worldDataSourceIdSchema).min(1),
]);

export const worldDataSourceDescriptorSchema = z
  .object({
    kind: worldDataSourceKindSchema,
    path: z.string().min(1),
    schema: z.string().min(1).optional(),
    to: z.string().min(1),
    key: z.string().min(1).optional(),
    indexTo: z.string().min(1).optional(),
    effects: z.array(worldDataEffectSchema).optional(),
    enabled: z.boolean().optional(),
    locale: z.string().min(2).optional(),
    merge: worldDataMergeModeSchema.optional(),
    after: afterSchema.optional(),
  })
  .strict();

export const worldDataDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.record(worldDataSourceIdSchema, worldDataSourceDescriptorSchema),
  })
  .strict();

export const worldDataSourceDescriptorOverrideSchema =
  worldDataSourceDescriptorSchema.partial().strict();

export const worldDataDescriptorOverrideSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.record(
      worldDataSourceIdSchema,
      worldDataSourceDescriptorOverrideSchema,
    ),
  })
  .strict();

export const worldDataDiagnosticCountsSchema = z
  .object({
    info: z.number().int().min(0),
    warning: z.number().int().min(0),
    error: z.number().int().min(0),
  })
  .strict();

export const worldDataSourceSummarySchema = z
  .object({
    id: worldDataSourceIdSchema,
    digest: z.string().min(1),
    target: z.string().min(1),
    schema: z.string().min(1).optional(),
    importedAt: z.string().min(1).optional(),
    order: z.number().int().min(0),
    origin: z.enum(["world", "override"]),
    overridden: z.boolean().optional(),
    diagnostics: worldDataDiagnosticCountsSchema,
  })
  .strict();

export const worldDataMetadataSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(worldDataSourceSummarySchema),
  })
  .strict();

export type WorldDataDescriptorInput = z.input<
  typeof worldDataDescriptorSchema
>;

export type WorldDataDescriptorOverrideInput = z.input<
  typeof worldDataDescriptorOverrideSchema
>;
