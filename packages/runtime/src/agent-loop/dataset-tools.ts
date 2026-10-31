/**
 * Dataset tools: the typed tools an agent gets over a dataset of its own
 * package (`agent.tools.datasets`). For each selected kind the kernel builds
 * `<dataset>-get`, `-list`, `-upsert` or `-update` from the dataset's
 * declaration and record schema at run start.
 *
 * Reads go through the tool's scoped store view, so they see the run's own
 * buffered writes and those of completed upstream runtimes of the same
 * plugin, and they are recorded as read dependencies. Writes are checked
 * against the record schema before anything is staged, then staged as one
 * `plugin.data.update` proposal; the commit checks the dataset again.
 * The tools never reach another plugin's data.
 */

import {
  applyDataOps,
  compareText,
  dataOpSchema,
  datasetKey,
  datasetToolName,
  pluginDataToolSizeError,
  type DataOp,
  type DataOpError,
  type DataOpKind,
  type DatasetToolKind,
  type JsonValue,
  type PluginDatasetDecl,
  type Proposal,
  type RuntimeManifest,
} from "@covel/shared";
import {
  tool,
  toolParametersJsonSchema,
  validateOutput,
  withPendingProposals,
  ToolError,
  z,
  type ToolModule,
} from "@covel/tools";
import type { ToolExecutionContext } from "@covel/tools";

type JsonSchema = Readonly<Record<string, unknown>>;

/** Longest key, in UTF-16 units, a dataset tool writes or looks up. */
export const MAX_DATASET_KEY_LENGTH = 256;
/** Records one `list` call returns by default, and at most. */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
/** Schema problems a failed check reports. */
const MAX_SCHEMA_ERRORS = 3;

const READ_ANNOTATIONS = Object.freeze({
  readOnly: true,
  stagesWrites: false,
  idempotent: true,
  concurrencySafe: true,
});
const UPSERT_ANNOTATIONS = Object.freeze({
  readOnly: false,
  stagesWrites: true,
  idempotent: true,
  concurrencySafe: false,
});
const UPDATE_ANNOTATIONS = Object.freeze({
  readOnly: false,
  stagesWrites: true,
  idempotent: false,
  concurrencySafe: false,
});

/** The tools of every dataset a runtime selected, by tool name. */
export function datasetToolNames(manifest: RuntimeManifest): string[] {
  if (manifest.runtimeType === "function") return [];
  return (manifest.tools?.datasets ?? []).flatMap(({ dataset, tools }) =>
    tools.map((kind) => datasetToolName(dataset, kind)),
  );
}

/**
 * Build the dataset tools a runtime selected. Throws when a selected
 * dataset's declaration or record schema is not loaded: the manifest is
 * wrong, so the runtime cannot start.
 */
export function createDatasetTools(
  manifest: RuntimeManifest,
  schemas: Readonly<Record<string, JsonSchema>> | undefined,
): Map<string, ToolModule> {
  const tools = new Map<string, ToolModule>();
  for (const { dataset, tools: kinds } of manifest.tools?.datasets ?? []) {
    if (kinds.length === 0) continue;
    const declaration =
      manifest.datasets && Object.hasOwn(manifest.datasets, dataset)
        ? manifest.datasets[dataset]
        : undefined;
    const schema =
      schemas && Object.hasOwn(schemas, dataset) ? schemas[dataset] : undefined;
    if (!declaration || !schema)
      throw new Error(
        `runtime "${manifest.name}" uses dataset "${dataset}", but its declaration or schema is not loaded`,
      );
    const spec: DatasetSpec = {
      dataset,
      declaration,
      schema,
      selected: new Set(kinds),
    };
    for (const kind of kinds)
      tools.set(datasetToolName(dataset, kind), buildTool(spec, kind));
  }
  return tools;
}

interface DatasetSpec {
  readonly dataset: string;
  readonly declaration: PluginDatasetDecl;
  readonly schema: JsonSchema;
  /** The kinds this runtime selected: hints name only tools it has. */
  readonly selected: ReadonlySet<DatasetToolKind>;
}

function buildTool(spec: DatasetSpec, kind: DatasetToolKind): ToolModule {
  switch (kind) {
    case "get":
      return getTool(spec);
    case "list":
      return listTool(spec);
    case "upsert":
      return upsertTool(spec);
    case "update":
      return updateTool(spec);
  }
}

// ── Descriptions and schemas ─────────────────────────────────────

function describe(spec: DatasetSpec, text: string): string {
  const { description } = spec.declaration;
  return description
    ? `${text}\n\nThe ${spec.dataset} dataset: ${description}`
    : text;
}

function keyDescription(spec: DatasetSpec): string {
  const field = spec.declaration.key;
  return field
    ? `The record's ${field}. Case and spacing do not matter.`
    : "The record's key. Case and spacing do not matter.";
}

/**
 * The tool's JSON Schema with the record schema embedded. Root `$defs` and
 * `definitions` move to the tool's root, so local `#/$defs/…` references
 * still resolve; `$schema` and `$id` are dropped, and patterns a provider
 * cannot read are left out.
 */
function toolJsonSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
  record?: JsonSchema,
): JsonSchema {
  const lifted: Record<string, unknown> = {};
  let embedded: Record<string, unknown> | undefined;
  if (record) {
    const {
      $schema: _schema,
      $id: _id,
      $defs,
      definitions,
      ...rest
    } = structuredClone(record) as Record<string, unknown>;
    embedded = rest;
    if ($defs !== undefined) lifted.$defs = $defs;
    if (definitions !== undefined) lifted.definitions = definitions;
  }
  const schema = {
    type: "object",
    properties: embedded ? { ...properties, record: embedded } : properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
    ...lifted,
  };
  return toolParametersJsonSchema({ toJSONSchema: () => schema });
}

const pathProperty = {
  type: "string",
  description:
    'JSON Pointer to the part of the record to change, such as "/stats/hp". Omit for the whole record.',
};

/** One JSON Schema per operation kind; `dataOpSchema` has no JSON form. */
const OP_JSON_SCHEMAS: Readonly<Record<DataOpKind, JsonSchema>> = {
  set: {},
  merge: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["merge"] },
      path: pathProperty,
      value: {
        type: "object",
        description: "Fields to set; null removes a field.",
      },
    },
    required: ["op", "value"],
    additionalProperties: false,
  },
  inc: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["inc"] },
      path: pathProperty,
      by: { type: "number", description: "Amount to add; negative subtracts." },
      min: { type: "number" },
      max: { type: "number" },
      onBound: {
        type: "string",
        enum: ["reject", "clamp"],
        description:
          "What happens when the result passes min or max. Defaults to reject.",
      },
    },
    required: ["op", "by"],
    additionalProperties: false,
  },
  append: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["append"] },
      path: pathProperty,
      value: { description: "Item to add at the end of the list." },
    },
    required: ["op", "value"],
    additionalProperties: false,
  },
  insert: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["insert"] },
      path: pathProperty,
      index: { type: "integer", minimum: 0 },
      value: { description: "Item to insert." },
    },
    required: ["op", "index", "value"],
    additionalProperties: false,
  },
  remove: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["remove"] },
      path: pathProperty,
      value: { description: "The item to remove. Give value or match." },
      match: {
        type: "object",
        description: "Fields the items to remove have. Give value or match.",
      },
    },
    required: ["op"],
    additionalProperties: false,
  },
  upsertItem: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["upsertItem"] },
      path: pathProperty,
      key: {
        type: "string",
        description: "Field that identifies an item of the list.",
      },
      value: {
        type: "object",
        description: "The item; replaces the item with the same key field.",
      },
    },
    required: ["op", "key", "value"],
    additionalProperties: false,
  },
  delete: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["delete"],
        description: "Delete the record.",
      },
    },
    required: ["op"],
    additionalProperties: false,
  },
};

/** The operation kinds `update` accepts: the dataset's, without `set`. */
function updateKinds(spec: DatasetSpec): DataOpKind[] {
  return spec.declaration.ops.filter((op) => op !== "set");
}

// ── Reads ────────────────────────────────────────────────────────

interface Row {
  readonly key: string;
  readonly value: unknown;
}

function storeOf(
  spec: DatasetSpec,
  context: ToolExecutionContext,
): NonNullable<ToolExecutionContext["store"]> {
  if (!context.store)
    throw new ToolError(
      "unavailable",
      `The ${spec.dataset} dataset cannot be reached here.`,
    );
  return context.store;
}

/** The normalized key of `raw`, refused when empty or too long. */
function normalizedKey(spec: DatasetSpec, raw: string): string {
  const key = datasetKey(raw);
  if (key === "")
    throw new ToolError(
      "invalid-input",
      `The ${spec.dataset} key is empty; give a key with text in it.`,
    );
  if (key.length > MAX_DATASET_KEY_LENGTH)
    throw new ToolError(
      "invalid-input",
      `The ${spec.dataset} key is longer than ${MAX_DATASET_KEY_LENGTH} characters; use a shorter one.`,
    );
  return key;
}

/**
 * The row `raw` addresses: the one stored under `raw` exactly, otherwise
 * the one stored under its normalized key.
 */
async function findRow(
  spec: DatasetSpec,
  context: ToolExecutionContext,
  raw: string,
): Promise<{ readonly key: string; readonly row: Row | null }> {
  const store = storeOf(spec, context);
  const key = normalizedKey(spec, raw);
  if (raw !== key) {
    const exact = await store.getPluginData(spec.dataset, raw);
    if (exact) return { key: raw, row: exact };
  }
  return { key, row: await store.getPluginData(spec.dataset, key) };
}

function notFound(spec: DatasetSpec, raw: string, hintKind: DatasetToolKind) {
  const hint = spec.selected.has(hintKind)
    ? hintKind === "list"
      ? `List records with ${datasetToolName(spec.dataset, "list")}.`
      : `Create it with ${datasetToolName(spec.dataset, "upsert")}.`
    : undefined;
  return new ToolError(
    "not-found",
    `No ${spec.dataset} record has the key "${raw}".`,
    hint ? { hint } : undefined,
  );
}

function getTool(spec: DatasetSpec): ToolModule {
  const name = datasetToolName(spec.dataset, "get");
  const module = tool({
    name,
    description: describe(spec, `Read one ${spec.dataset} record by its key.`),
    parameters: z.object({ key: z.string() }),
    annotations: READ_ANNOTATIONS,
    async execute({ key: raw }, context) {
      const { key, row } = await findRow(spec, context, raw);
      if (!row) throw notFound(spec, raw, "list");
      return { key, record: row.value };
    },
  });
  return {
    ...module,
    jsonSchema: toolJsonSchema(
      { key: { type: "string", description: keyDescription(spec) } },
      ["key"],
    ),
  };
}

const whereValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function listTool(spec: DatasetSpec): ToolModule {
  const name = datasetToolName(spec.dataset, "list");
  const field = spec.declaration.key;
  const module = tool({
    name,
    description: describe(
      spec,
      `List ${spec.dataset} records, sorted by key, ${LIST_DEFAULT_LIMIT} at a time. When the result has nextOffset, call again with that offset for more.`,
    ),
    parameters: z.object({
      where: z.record(z.string(), whereValue).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
    }),
    annotations: READ_ANNOTATIONS,
    async execute({ where, offset = 0, limit = LIST_DEFAULT_LIMIT }, context) {
      const rows = await storeOf(spec, context).listPluginData(spec.dataset);
      const conditions = Object.entries(where ?? {});
      const matching = rows
        .filter((row) => matches(row.value, conditions))
        .sort((a, b) => compareText(a.key, b.key));
      const page = matching.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        total: matching.length,
        items: page.map((row) => ({ key: row.key, record: row.value })),
        ...(next < matching.length ? { nextOffset: next } : {}),
      };
    },
  });
  return {
    ...module,
    jsonSchema: toolJsonSchema(
      {
        where: {
          type: "object",
          description: `Only records whose top-level fields have exactly these values${field ? `, such as { "${field}": "…" }` : ""}.`,
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Records to skip. Defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LIST_MAX_LIMIT,
          description: `Records to return. Defaults to ${LIST_DEFAULT_LIMIT}.`,
        },
      },
      [],
    ),
  };
}

function matches(
  value: unknown,
  conditions: readonly (readonly [string, unknown])[],
): boolean {
  if (conditions.length === 0) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return conditions.every(
    ([field, expected]) =>
      Object.hasOwn(record, field) && record[field] === expected,
  );
}

// ── Writes ───────────────────────────────────────────────────────

/** Schema problems, at most three, or undefined when the record fits. */
function schemaProblems(
  spec: DatasetSpec,
  record: unknown,
): string | undefined {
  let result: ReturnType<typeof validateOutput>;
  try {
    result = validateOutput(record, spec.schema);
  } catch (error) {
    console.error(
      `[dataset-tools] the record schema of dataset "${spec.dataset}" cannot be compiled:`,
      error,
    );
    throw new ToolError(
      "internal",
      `The ${spec.dataset} dataset's schema cannot be used.`,
    );
  }
  if (result.valid) return undefined;
  const errors = (result.errors ?? []).slice(0, MAX_SCHEMA_ERRORS);
  return errors.map((error) => `record${error}`).join("; ");
}

/**
 * Apply the operations to the current record and check the result the way
 * the commit will: size, then schema. Nothing is staged when this throws.
 */
function checkedResult(
  spec: DatasetSpec,
  key: string,
  current: Row | null,
  ops: readonly DataOp[],
):
  | { readonly exists: false }
  | { readonly exists: true; readonly value: JsonValue } {
  const applied = applyDataOps(
    current
      ? { exists: true, value: current.value as JsonValue }
      : { exists: false },
    ops,
  );
  if (!applied.ok) throw opFailure(spec, key, applied.error);
  if (!applied.exists) return applied;
  const tooLarge = pluginDataToolSizeError(spec.dataset, key, applied.value);
  if (tooLarge) throw new ToolError("invalid-input", tooLarge);
  const problems = schemaProblems(spec, applied.value);
  if (problems)
    throw new ToolError(
      "invalid-input",
      `The ${spec.dataset} record does not match the dataset's schema: ${problems}. Nothing was written.`,
    );
  return applied;
}

/**
 * A malformed operation is the call's mistake; a well-formed one that does
 * not fit the record conflicts with the stored or staged data.
 */
function opFailure(spec: DatasetSpec, key: string, error: DataOpError) {
  const where = error.path ? ` at ${error.path}` : "";
  const message = `Operation ${error.opIndex} cannot change the ${spec.dataset} record "${key}"${where}: ${error.message}. Nothing was written.`;
  if (error.code === "invalid-op" || error.code === "invalid-path")
    return new ToolError("invalid-input", message);
  return new ToolError(
    "conflict",
    message,
    spec.selected.has("get")
      ? {
          hint: `Read the record with ${datasetToolName(spec.dataset, "get")} and adjust.`,
        }
      : undefined,
  );
}

function stage(
  spec: DatasetSpec,
  context: ToolExecutionContext,
  key: string,
  ops: readonly DataOp[],
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data.update",
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload: { namespace: spec.dataset, key, ops: [...ops] },
    timestamp: new Date().toISOString(),
  };
}

function upsertTool(spec: DatasetSpec): ToolModule {
  const name = datasetToolName(spec.dataset, "upsert");
  const field = spec.declaration.key;
  const record = z.json().refine((value) => value !== undefined, {
    message: "record is required",
  });
  const description = field
    ? `Create a ${spec.dataset} record, or replace the one with the same ${field} (case and spacing do not matter). Send the whole record.`
    : `Create the ${spec.dataset} record under key, or replace the one already there (case and spacing do not matter). Send the whole record.`;
  const module = tool({
    name,
    description: describe(spec, description),
    parameters: field
      ? z.object({ record })
      : z.object({ key: z.string(), record }),
    annotations: UPSERT_ANNOTATIONS,
    async execute(params, context) {
      const value = params.record as JsonValue;
      let raw: string;
      if (field) {
        const named =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)[field]
            : undefined;
        if (typeof named !== "string")
          throw new ToolError(
            "invalid-input",
            `record.${field} must be a string: it is the ${spec.dataset} record's key. Nothing was written.`,
          );
        raw = named;
      } else raw = (params as unknown as { key: string }).key;
      const { key, row } = await findRow(spec, context, raw);
      const ops: DataOp[] = [{ op: "set", value }];
      checkedResult(spec, key, row, ops);
      return withPendingProposals(
        { key, record: value, created: row === null },
        [stage(spec, context, key, ops)],
      );
    },
  });
  return {
    ...module,
    jsonSchema: toolJsonSchema(
      field
        ? {}
        : { key: { type: "string", description: keyDescription(spec) } },
      field ? ["record"] : ["key", "record"],
      spec.schema,
    ),
  };
}

function updateTool(spec: DatasetSpec): ToolModule {
  const name = datasetToolName(spec.dataset, "update");
  const field = spec.declaration.key;
  const kinds = updateKinds(spec);
  const allowed = new Set<string>(kinds);
  const op = z.unknown().superRefine((value, ctx) => {
    const kind =
      value !== null && typeof value === "object"
        ? (value as { op?: unknown }).op
        : undefined;
    if (typeof kind !== "string" || !allowed.has(kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["op"],
        message: `op must be one of ${kinds.join(", ")}`,
      });
      return;
    }
    const parsed = dataOpSchema.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue } as Parameters<typeof ctx.addIssue>[0]);
  });
  const upsertHint = spec.selected.has("upsert")
    ? ` To replace a whole record, use ${datasetToolName(spec.dataset, "upsert")}.`
    : "";
  const module = tool({
    name,
    description: describe(
      spec,
      `Change an existing ${spec.dataset} record with operations (${kinds.join(", ")}), applied in order; all apply or none.${upsertHint}`,
    ),
    parameters: z.object({
      key: z.string(),
      ops: z.array(op).min(1).max(64),
    }),
    annotations: UPDATE_ANNOTATIONS,
    async execute(params, context) {
      const ops = params.ops as DataOp[];
      const { key, row } = await findRow(spec, context, params.key);
      if (!row) throw notFound(spec, params.key, "upsert");
      const result = checkedResult(spec, key, row, ops);
      if (!result.exists)
        return withPendingProposals({ key, deleted: true }, [
          stage(spec, context, key, ops),
        ]);
      if (field && keyFieldChanged(row.value, result.value, field))
        throw new ToolError(
          "invalid-input",
          `update cannot change ${field}; upsert a new record and delete this one. Nothing was written.`,
        );
      return withPendingProposals({ key, record: result.value }, [
        stage(spec, context, key, ops),
      ]);
    },
  });
  return {
    ...module,
    jsonSchema: toolJsonSchema(
      {
        key: { type: "string", description: keyDescription(spec) },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "Operations, applied in order.",
          items: { anyOf: kinds.map((kind) => OP_JSON_SCHEMAS[kind]) },
        },
      },
      ["key", "ops"],
    ),
  };
}

function keyFieldChanged(before: unknown, after: unknown, field: string) {
  const of = (value: unknown): unknown =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[field]
      : undefined;
  const old = of(before);
  const next = of(after);
  if (typeof old !== "string" || typeof next !== "string") return old !== next;
  return datasetKey(old) !== datasetKey(next);
}
