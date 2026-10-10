import type { JsonValue } from "./types.js";
import type {
  DimensionDerivation,
  DimensionValueSchema,
} from "./dimension-types.js";

/**
 * What a derivation can read. A source that is absent leaves the fields that
 * read it as they are.
 */
export interface DimensionDerivationSources {
  /** The world clock after this turn, counted in its base unit. */
  readonly clock?: { readonly elapsedSinceStart: number };
}

/** A node of a dimension schema that carries `x-derive`. */
export interface DerivedDimensionField {
  /** Property names from the root of the value; empty for the whole value. */
  readonly path: readonly string[];
  readonly schema: DimensionValueSchema;
  readonly derivation: DimensionDerivation;
}

/**
 * The derived fields of a schema. A derived field is the value itself or a
 * property reached through `properties` only: an array element or a
 * dynamically named record has no fixed place to compute.
 */
export function derivedDimensionFields(
  schema: DimensionValueSchema,
): readonly DerivedDimensionField[] {
  const fields: DerivedDimensionField[] = [];
  const visit = (node: DimensionValueSchema, path: readonly string[]): void => {
    const derivation = node["x-derive"];
    if (derivation) {
      fields.push({ path, schema: node, derivation });
      return;
    }
    for (const [key, child] of Object.entries(node.properties ?? {}))
      visit(child, [...path, key]);
  };
  visit(schema, []);
  return fields;
}

/** The number a derivation gives for one source value, before any label. */
export function deriveDimensionNumber(
  derivation: DimensionDerivation,
  source: number,
): number {
  const linear = (derivation.start ?? 0) + (derivation.perUnit ?? 1) * source;
  return Math.min(
    derivation.max ?? Infinity,
    Math.max(derivation.min ?? -Infinity, linear),
  );
}

/**
 * The value of one derived field. It depends on the source value only, so a
 * turn that is run again, or a session forked from an earlier turn, gets the
 * value its clock gives.
 */
export function deriveDimensionValue(
  schema: DimensionValueSchema,
  derivation: DimensionDerivation,
  source: number,
): JsonValue {
  const number = deriveDimensionNumber(derivation, source);
  if (!derivation.ranges)
    return schema.type === "integer" ? Math.round(number) : number;
  const range = derivation.ranges.find(
    ({ from, to }) =>
      (from === undefined || number >= from) &&
      (to === undefined || number <= to),
  );
  // The schema requires a last range without bounds, so one always matches.
  return (range ?? derivation.ranges.at(-1)!).value;
}

function sourceValue(
  derivation: DimensionDerivation,
  sources: DimensionDerivationSources,
): number | undefined {
  const value =
    derivation.source === "clock.elapsedSinceStart"
      ? sources.clock?.elapsedSinceStart
      : undefined;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

type JsonObject = { [key: string]: JsonValue };

// `JsonValue` is read-only; the values written here are copies made in this
// module.
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readPath(
  value: JsonValue,
  path: readonly string[],
): { readonly value: JsonValue } | undefined {
  let node: JsonValue = value;
  for (const key of path) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key]!;
  }
  return { value: node };
}

/** Set a field in `value`, which is already a copy. A missing parent is not created. */
function writePath(
  value: JsonValue,
  path: readonly string[],
  field: JsonValue,
): JsonValue {
  const last = path.at(-1);
  if (last === undefined) return field;
  let node: JsonValue = value;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return value;
    node = node[key]!;
  }
  if (isObject(node)) (node as JsonObject)[last] = field;
  return value;
}

/**
 * `value` with every derived field set to what its source gives now. Fields
 * whose source is absent, and all other fields, stay as they are.
 */
export function applyDimensionDerivations(
  schema: DimensionValueSchema,
  value: JsonValue,
  sources: DimensionDerivationSources,
): JsonValue {
  let next = structuredClone(value);
  for (const field of derivedDimensionFields(schema)) {
    const source = sourceValue(field.derivation, sources);
    if (source === undefined) continue;
    next = writePath(
      next,
      field.path,
      deriveDimensionValue(field.schema, field.derivation, source),
    );
  }
  return next;
}

/**
 * `written` with every derived field taken from `current`. A writer that is
 * not the derivation (a model, a player's edit) cannot change a derived field
 * and does not have to repeat it.
 */
export function keepDerivedDimensionFields(
  schema: DimensionValueSchema,
  written: JsonValue,
  current: JsonValue,
): JsonValue {
  let next = structuredClone(written);
  for (const { path } of derivedDimensionFields(schema)) {
    const kept = readPath(current, path);
    if (kept) next = writePath(next, path, structuredClone(kept.value));
  }
  return next;
}

/**
 * The schema without its derived fields, for a reader that must not write
 * them. `undefined` when the whole value is derived.
 */
export function dimensionSchemaWithoutDerived(
  schema: DimensionValueSchema,
): DimensionValueSchema | undefined {
  if (schema["x-derive"]) return undefined;
  if (!schema.properties) return schema;
  const properties: Record<string, DimensionValueSchema> = {};
  for (const [key, child] of Object.entries(schema.properties)) {
    const kept = dimensionSchemaWithoutDerived(child);
    if (kept) properties[key] = kept;
  }
  return {
    ...schema,
    properties,
    ...(schema.required
      ? {
          required: schema.required.filter((key) =>
            Object.hasOwn(properties, key),
          ),
        }
      : {}),
  };
}

/** The value without its derived fields; pairs with `dimensionSchemaWithoutDerived`. */
export function dimensionValueWithoutDerived(
  schema: DimensionValueSchema,
  value: JsonValue,
): JsonValue {
  if (!schema.properties || !isObject(value)) return value;
  const next: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const child = Object.hasOwn(schema.properties, key)
      ? schema.properties[key]
      : undefined;
    if (child?.["x-derive"]) continue;
    next[key] = child ? dimensionValueWithoutDerived(child, item) : item;
  }
  return next;
}
