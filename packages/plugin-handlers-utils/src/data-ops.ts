import { z } from "zod";
import type { JsonValue } from "./types.js";

/** Operation kinds a plugin-data update may contain. */
export const DATA_OP_KINDS = [
  "set",
  "merge",
  "inc",
  "append",
  "insert",
  "remove",
  "upsertItem",
  "delete",
] as const;

export type DataOpKind = (typeof DATA_OP_KINDS)[number];

type JsonObject = { readonly [key: string]: JsonValue };

/**
 * One typed update to a plugin-data value. `path` is an RFC 6901 JSON Pointer
 * into the value; omitted or `""` addresses the whole value. `delete` always
 * addresses the whole key: removing a field is `merge` with a `null` entry.
 */
export type DataOp =
  | { readonly op: "set"; readonly value: JsonValue }
  | {
      readonly op: "merge";
      readonly path?: string;
      readonly value: { readonly [key: string]: JsonValue | null };
    }
  | {
      readonly op: "inc";
      readonly path?: string;
      readonly by: number;
      readonly min?: number;
      readonly max?: number;
      /** Defaults to `"reject"`. */
      readonly onBound?: "reject" | "clamp";
    }
  | { readonly op: "append"; readonly path?: string; readonly value: JsonValue }
  | {
      readonly op: "insert";
      readonly path?: string;
      readonly index: number;
      readonly value: JsonValue;
    }
  | {
      readonly op: "remove";
      readonly path?: string;
      /** Exactly one of `value` / `match`. */
      readonly value?: JsonValue;
      readonly match?: { readonly [key: string]: JsonValue };
    }
  | {
      readonly op: "upsertItem";
      readonly path?: string;
      readonly key: string;
      readonly value: { readonly [key: string]: JsonValue };
    }
  | { readonly op: "delete" };

/**
 * Internal failure codes. These are not the tool-facing codes of the
 * plugin-data tools; callers map them where they surface to a model.
 */
export type DataOpErrorCode =
  | "invalid-op"
  | "invalid-path"
  | "path-not-found"
  | "type-mismatch"
  | "out-of-bounds"
  | "index-out-of-range"
  | "duplicate-item";

export interface DataOpError {
  readonly code: DataOpErrorCode;
  /** Index of the failing operation in the list. */
  readonly opIndex: number;
  readonly path?: string;
  /** English and model-safe: no identifiers. */
  readonly message: string;
}

export type DataOpsCurrent =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: JsonValue };

export type DataOpsResult =
  | { readonly ok: true; readonly exists: false }
  | { readonly ok: true; readonly exists: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: DataOpError };

// ── Schemas ──────────────────────────────────────────────────────────────

const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const ARRAY_TOKEN = /^(?:0|[1-9][0-9]*)$/;
const MAX_OPS = 64;

type PointerResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly message: string };

function parsePointer(path: string | undefined): PointerResult {
  if (path === undefined || path === "") return { ok: true, tokens: [] };
  if (!path.startsWith("/"))
    return { ok: false, message: "path must be a JSON Pointer" };
  const tokens: string[] = [];
  for (const raw of path.slice(1).split("/")) {
    if (/~(?![01])/.test(raw))
      return { ok: false, message: "path has an invalid escape" };
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_TOKENS.has(token))
      return { ok: false, message: "path has a reserved segment" };
    tokens.push(token);
  }
  return { ok: true, tokens };
}

const pathSchema = z
  .string()
  .refine((path) => parsePointer(path).ok, { message: "Invalid JSON Pointer" })
  .optional();

const finite = z.number().finite();
const jsonValue = z.json();

function hasForbiddenKey(record: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(record).some((key) => FORBIDDEN_TOKENS.has(key));
}

// Checked on the input: zod's record parser would silently drop `__proto__`.
const keyedRecord = (nullable: boolean) => {
  const entries = z.record(
    z.string(),
    nullable ? z.json().nullable() : jsonValue,
  );
  return z.custom<Record<string, JsonValue | null>>(
    (record) =>
      typeof record === "object" &&
      record !== null &&
      !hasForbiddenKey(record as Record<string, unknown>) &&
      entries.safeParse(record).success,
    { message: "Expected a JSON object without reserved keys" },
  );
};

export const dataOpSchema: z.ZodType<DataOp> = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), value: jsonValue }),
  z.strictObject({
    op: z.literal("merge"),
    path: pathSchema,
    value: keyedRecord(true),
  }),
  z
    .strictObject({
      op: z.literal("inc"),
      path: pathSchema,
      by: finite,
      min: finite.optional(),
      max: finite.optional(),
      onBound: z.enum(["reject", "clamp"]).optional(),
    })
    .refine(
      (op) => op.min === undefined || op.max === undefined || op.min <= op.max,
      { message: "min must not exceed max", path: ["min"] },
    ),
  z.strictObject({
    op: z.literal("append"),
    path: pathSchema,
    value: jsonValue,
  }),
  z.strictObject({
    op: z.literal("insert"),
    path: pathSchema,
    index: z.number().int().min(0),
    value: jsonValue,
  }),
  z
    .strictObject({
      op: z.literal("remove"),
      path: pathSchema,
      value: jsonValue.optional(),
      match: keyedRecord(false)
        .refine((record) => Object.keys(record).length > 0, {
          message: "match must have at least one field",
        })
        .optional(),
    })
    .refine((op) => (op.value !== undefined) !== (op.match !== undefined), {
      message: "Provide exactly one of value or match",
    }),
  z
    .strictObject({
      op: z.literal("upsertItem"),
      path: pathSchema,
      key: z.string(),
      value: keyedRecord(false),
    })
    .refine((op) => isPrimitive(op.value[op.key]), {
      message: "value[key] must exist and be a JSON primitive",
      path: ["value"],
    }),
  z.strictObject({ op: z.literal("delete") }),
]) as unknown as z.ZodType<DataOp>;

export const dataOpsSchema = z.array(dataOpSchema).min(1).max(MAX_OPS);

// ── Helpers ──────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i] as JsonValue));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        jsonEqual(a[key] as JsonValue, b[key] as JsonValue),
    );
  }
  return false;
}

function setKey(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A shallow copy that keeps keys as own data properties. */
function copyObject(source: JsonObject): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(source))
    setKey(out, key, source[key] as JsonValue);
  return out;
}

class OpFailure {
  constructor(
    readonly code: DataOpErrorCode,
    readonly message: string,
  ) {}
}

function fail(code: DataOpErrorCode, message: string): never {
  throw new OpFailure(code, message);
}

// ── Per-op application ───────────────────────────────────────────────────

type Transform = (target: JsonValue | undefined) => JsonValue;

/**
 * Rebuilds `node` with the value at `tokens[i..]` replaced by `fn(...)`.
 * Only the last segment may be absent; every container on the way is copied.
 */
function modifyAt(
  node: JsonValue | undefined,
  tokens: readonly string[],
  i: number,
  fn: Transform,
): JsonValue {
  if (i === tokens.length) return fn(node);
  const token = tokens[i] as string;
  const last = i === tokens.length - 1;
  if (Array.isArray(node)) {
    if (!ARRAY_TOKEN.test(token))
      fail("invalid-path", "path segment is not an array index");
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index >= node.length)
      fail("path-not-found", "path does not exist");
    const out = node.slice();
    out[index] = modifyAt(node[index], tokens, i + 1, fn);
    return out;
  }
  if (isPlainObject(node)) {
    const has = Object.hasOwn(node, token);
    if (!has && !last) fail("path-not-found", "path does not exist");
    const out = copyObject(node);
    setKey(
      out,
      token,
      modifyAt(has ? node[token] : undefined, tokens, i + 1, fn),
    );
    return out;
  }
  return fail("type-mismatch", "path crosses a value that is not a container");
}

function requireArray(
  target: JsonValue | undefined,
  kind: string,
): JsonValue[] {
  if (target === undefined) return [];
  if (!Array.isArray(target))
    fail("type-mismatch", `${kind} needs an array target`);
  return target;
}

function requireKeys(
  record: unknown,
  what: string,
): asserts record is JsonObject {
  if (!isPlainObject(record)) fail("invalid-op", `${what} must be an object`);
  if (Object.keys(record).some((key) => FORBIDDEN_TOKENS.has(key)))
    fail("invalid-op", `${what} has a reserved key`);
}

function transformFor(op: DataOp): Transform {
  switch (op.op) {
    case "merge": {
      const patch: unknown = op.value;
      if (
        !isPlainObject(patch as JsonValue) ||
        !Object.values(patch as object).every(
          (v) => v === null || isJsonValue(v),
        )
      )
        fail("invalid-op", "merge value must be an object of JSON values");
      requireKeys(patch, "merge value");
      return (target) => {
        if (target !== undefined && !isPlainObject(target))
          fail("type-mismatch", "merge needs an object target");
        const out = copyObject((target ?? {}) as JsonObject);
        for (const key of Object.keys(patch)) {
          const entry = patch[key] as JsonValue | null;
          if (entry === null) delete out[key];
          else setKey(out, key, entry);
        }
        return out;
      };
    }
    case "inc": {
      const { by, min, max } = op;
      const onBound: unknown = op.onBound ?? "reject";
      if (typeof by !== "number" || !Number.isFinite(by))
        fail("invalid-op", "inc needs a finite number");
      for (const bound of [min, max])
        if (
          bound !== undefined &&
          !(typeof bound === "number" && Number.isFinite(bound))
        )
          fail("invalid-op", "inc bounds must be finite numbers");
      if (min !== undefined && max !== undefined && min > max)
        fail("invalid-op", "inc min must not exceed max");
      if (onBound !== "reject" && onBound !== "clamp")
        fail("invalid-op", "inc onBound must be reject or clamp");
      return (target) => {
        if (
          target !== undefined &&
          !(typeof target === "number" && Number.isFinite(target))
        )
          fail("type-mismatch", "inc needs a number target");
        let result = ((target as number | undefined) ?? 0) + by;
        if (!Number.isFinite(result))
          fail("out-of-bounds", "inc result is not a finite number");
        const below = min !== undefined && result < min;
        const above = max !== undefined && result > max;
        if (below || above) {
          if (onBound === "reject")
            fail("out-of-bounds", "inc result is outside the allowed range");
          result = below ? (min as number) : (max as number);
        }
        return result === 0 ? 0 : result;
      };
    }
    case "append": {
      requireJson(op.value, "append value");
      const { value } = op;
      return (target) => [...requireArray(target, "append"), value];
    }
    case "insert": {
      requireJson(op.value, "insert value");
      const { index, value } = op;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
        fail("invalid-op", "insert index must be a non-negative integer");
      return (target) => {
        const list = requireArray(target, "insert");
        if (index > list.length)
          fail("index-out-of-range", "insert index is beyond the array end");
        return [...list.slice(0, index), value, ...list.slice(index)];
      };
    }
    case "remove": {
      const hasValue = op.value !== undefined;
      const hasMatch = op.match !== undefined;
      if (hasValue === hasMatch)
        fail("invalid-op", "remove needs exactly one of value or match");
      if (hasValue) {
        requireJson(op.value, "remove value");
        const value = op.value as JsonValue;
        return (target) =>
          requireArray(target, "remove").filter(
            (item) => !jsonEqual(item, value),
          );
      }
      const match: unknown = op.match;
      requireKeys(match, "remove match");
      const entries = Object.entries(match);
      if (entries.length === 0 || !entries.every(([, v]) => isJsonValue(v)))
        fail("invalid-op", "remove match needs at least one JSON field");
      return (target) =>
        requireArray(target, "remove").filter(
          (item) =>
            !(
              isPlainObject(item) &&
              entries.every(
                ([key, v]) =>
                  Object.hasOwn(item, key) &&
                  jsonEqual(item[key] as JsonValue, v),
              )
            ),
        );
    }
    case "upsertItem": {
      const { key } = op;
      const value: unknown = op.value;
      requireKeys(value, "upsertItem value");
      if (!isJsonValue(value))
        fail("invalid-op", "upsertItem value must be JSON");
      if (typeof key !== "string" || !isPrimitive(value[key]))
        fail("invalid-op", "upsertItem value[key] must be a JSON primitive");
      const identity = value[key] as JsonValue;
      return (target) => {
        const list = requireArray(target, "upsertItem");
        const hits: number[] = [];
        list.forEach((item, i) => {
          if (
            isPlainObject(item) &&
            Object.hasOwn(item, key) &&
            jsonEqual(item[key] as JsonValue, identity)
          )
            hits.push(i);
        });
        if (hits.length > 1)
          fail(
            "duplicate-item",
            "upsertItem key matches more than one element",
          );
        if (hits.length === 0) return [...list, value];
        const at = hits[0] as number;
        const merged = copyObject(list[at] as JsonObject);
        for (const field of Object.keys(value))
          setKey(merged, field, value[field] as JsonValue);
        const out = list.slice();
        out[at] = merged;
        return out;
      };
    }
    default:
      return fail("invalid-op", "unknown operation");
  }
}

function requireJson(value: unknown, what: string): asserts value is JsonValue {
  if (!isJsonValue(value)) fail("invalid-op", `${what} must be JSON`);
}

type State = JsonValue | undefined;

function applyOne(state: State, op: DataOp): State {
  if (typeof op !== "object" || op === null)
    fail("invalid-op", "operation must be an object");
  if (op.op === "delete") return undefined;
  if (op.op === "set") {
    requireJson(op.value, "set value");
    return op.value;
  }
  if (op.path !== undefined && typeof op.path !== "string")
    fail("invalid-op", "path must be a string");
  const pointer = parsePointer(op.path);
  if (!pointer.ok) fail("invalid-path", pointer.message);
  const fn = transformFor(op);
  // A path into an absent key starts from an empty object.
  const root = pointer.tokens.length > 0 && state === undefined ? {} : state;
  return modifyAt(root, pointer.tokens, 0, fn);
}

/**
 * Applies `ops` in order to a plugin-data value. Pure and total: it never
 * mutates its inputs, never throws, and returns either the complete result or
 * the first error with no partial value.
 *
 * An absent value starts from `0` (`inc`), `[]` (`append`, `insert`, `remove`,
 * `upsertItem`) or `{}` (`merge`). With a `path`, every segment but the last
 * must exist, and a pointer into an absent key starts from `{}`. Array
 * segments must name an existing index.
 */
export function applyDataOps(
  current: DataOpsCurrent,
  ops: readonly DataOp[],
): DataOpsResult {
  let state: State = current.exists ? current.value : undefined;
  for (const [opIndex, op] of ops.entries()) {
    try {
      state = applyOne(state, op);
    } catch (error) {
      const path =
        typeof op === "object" &&
        op !== null &&
        "path" in op &&
        typeof op.path === "string"
          ? op.path
          : undefined;
      const known = error instanceof OpFailure;
      return {
        ok: false,
        error: {
          code: known ? error.code : "invalid-op",
          opIndex,
          ...(path !== undefined ? { path } : {}),
          message: known ? error.message : "operation could not be applied",
        },
      };
    }
  }
  return state === undefined
    ? { ok: true, exists: false }
    : { ok: true, exists: true, value: state };
}
