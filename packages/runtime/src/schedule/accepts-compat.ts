/**
 * `accepts` static compatibility (docs 02 §3.1, build-time layer).
 *
 * Given a producer's declared `output.schema` projected by the binding `select`
 * pointer, try to PROVE that every value the producer may emit is accepted by
 * the consumer's `accepts` schema. This is deliberately NOT a general JSON
 * Schema subtype solver — it covers only the decidable subset the contract
 * names (type / const / enum / object properties·required·additionalProperties
 * / single `items` / numeric·length·array bounds / anchored MIME-prefix
 * `pattern`). Anything with a combinator (`oneOf` / `anyOf` / `allOf` / `not` /
 * `if`) or an unknown keyword is reported `indeterminate` so the caller falls
 * through to the always-on runtime Ajv check instead of guessing.
 *
 * Also hosts the RFC 6901 `select` resolver (value + schema projection); no
 * pointer-walking helper existed in the repo before this step.
 */

type Schema = Readonly<Record<string, unknown>>;

export type AcceptsCompatibility =
  "compatible" | "incompatible" | "indeterminate";

/** RFC 6901 unescape for a single reference token. */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolve an RFC 6901 JSON Pointer against a value. Empty pointer = whole
 * document. `found: false` distinguishes an absent path from a present `null`.
 */
export function resolveJsonPointer(
  value: unknown,
  pointer: string,
): { readonly found: boolean; readonly value?: unknown } {
  if (pointer === "") return { found: true, value };
  const tokens = pointer.split("/").slice(1).map(unescapeToken);
  let cursor: unknown = value;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== "object") return { found: false };
    if (Array.isArray(cursor)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return { found: false };
      }
      cursor = cursor[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cursor, token)) {
        return { found: false };
      }
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return { found: true, value: cursor };
}

/**
 * Project a producer output schema through a `select` pointer, walking
 * `properties` (objects) and `items` (arrays). Returns `undefined` when the
 * pointer cannot be resolved structurally — the caller treats that as
 * indeterminate rather than fabricating a type.
 */
export function projectSchemaBySelect(
  schema: Schema | undefined,
  select: string | undefined,
): Schema | undefined {
  if (!schema) return undefined;
  if (!select || select === "") return schema;
  const tokens = select.split("/").slice(1).map(unescapeToken);
  let cursor: Schema | undefined = schema;
  for (const token of tokens) {
    if (!cursor) return undefined;
    const props: unknown = cursor.properties;
    if (props && typeof props === "object" && token in (props as object)) {
      cursor = (props as Record<string, Schema>)[token];
      continue;
    }
    const items: unknown = cursor.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      // Single `items` schema — array index tokens all share the element schema.
      cursor = items as Schema;
      continue;
    }
    return undefined;
  }
  return cursor;
}

const KNOWN_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "title",
  "description",
  "$schema",
  "$id",
  "default",
  "examples",
]);

const COMBINATOR_KEYWORDS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
];

function hasUndecidableKeyword(schema: Schema): boolean {
  for (const key of Object.keys(schema)) {
    if (COMBINATOR_KEYWORDS.includes(key)) return true;
    if (!KNOWN_KEYWORDS.has(key)) return true;
  }
  return false;
}

function typeOf(schema: Schema): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

/** JSON Schema `type` of a concrete value (for `const` inference). */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value; // "string" | "boolean" | "object"
}

/** integer ⊆ number for width purposes; otherwise types must match. */
function typeCompatible(producer: string, accepts: string): boolean {
  if (producer === accepts) return true;
  return accepts === "number" && producer === "integer";
}

/**
 * Prove producer ⊆ accepts over the decidable subset. Returns `compatible`
 * only when provably so, `incompatible` when a value valid under producer is
 * provably rejected by accepts, `indeterminate` otherwise.
 */
export function checkAcceptsCompatibility(
  producer: Schema | undefined,
  accepts: Schema,
): AcceptsCompatibility {
  if (!producer) return "indeterminate";
  if (hasUndecidableKeyword(producer) || hasUndecidableKeyword(accepts)) {
    return "indeterminate";
  }

  // A producer `const` pins the type even when `type` is omitted.
  const pType =
    typeOf(producer) ??
    ("const" in producer ? jsonTypeOf(producer.const) : undefined);
  const aType = typeOf(accepts);

  // type
  if (aType !== undefined) {
    if (pType === undefined) return "indeterminate"; // producer unconstrained
    if (!typeCompatible(pType, aType)) return "incompatible";
  }

  // const / enum on accepts constrains the allowed value set.
  if ("const" in accepts) {
    if ("const" in producer) {
      return deepEqual(producer.const, accepts.const)
        ? "compatible"
        : "incompatible";
    }
    return "indeterminate";
  }
  if (Array.isArray(accepts.enum)) {
    const allowed = accepts.enum as unknown[];
    const producerValues = Array.isArray(producer.enum)
      ? (producer.enum as unknown[])
      : "const" in producer
        ? [producer.const]
        : undefined;
    if (!producerValues) return "indeterminate";
    return producerValues.every((v) => allowed.some((a) => deepEqual(a, v)))
      ? "compatible"
      : "incompatible";
  }

  // numeric bounds — producer's range must sit inside accepts' range.
  const numeric = compareNumericBounds(producer, accepts);
  if (numeric === "incompatible") return "incompatible";
  if (numeric === "indeterminate") return "indeterminate";

  // string length / array bounds
  const lengths = compareLengthBounds(producer, accepts);
  if (lengths === "incompatible") return "incompatible";
  if (lengths === "indeterminate") return "indeterminate";

  // anchored MIME-prefix pattern (e.g. accepts `^audio/`).
  if (typeof accepts.pattern === "string") {
    const patternResult = compareAnchoredPattern(producer, accepts.pattern);
    if (patternResult !== "compatible") return patternResult;
  }

  // object structure
  if (aType === "object" || typeOf(producer) === "object") {
    const obj = compareObjects(producer, accepts);
    if (obj !== "compatible") return obj;
  }

  return "compatible";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function compareNumericBounds(
  producer: Schema,
  accepts: Schema,
): AcceptsCompatibility {
  const aMin = accepts.minimum ?? accepts.exclusiveMinimum;
  const aMax = accepts.maximum ?? accepts.exclusiveMaximum;
  if (aMin === undefined && aMax === undefined) return "compatible";
  const pMin = producer.minimum ?? producer.exclusiveMinimum;
  const pMax = producer.maximum ?? producer.exclusiveMaximum;
  if (aMin !== undefined) {
    if (pMin === undefined) return "indeterminate";
    if (numberOr(pMin, -Infinity) < numberOr(aMin, -Infinity))
      return "incompatible";
  }
  if (aMax !== undefined) {
    if (pMax === undefined) return "indeterminate";
    if (numberOr(pMax, Infinity) > numberOr(aMax, Infinity))
      return "incompatible";
  }
  return "compatible";
}

function compareLengthBounds(
  producer: Schema,
  accepts: Schema,
): AcceptsCompatibility {
  for (const [minKey, maxKey] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const) {
    const aMin = accepts[minKey];
    const aMax = accepts[maxKey];
    if (typeof aMin === "number") {
      if (typeof producer[minKey] !== "number") return "indeterminate";
      if ((producer[minKey] as number) < aMin) return "incompatible";
    }
    if (typeof aMax === "number") {
      if (typeof producer[maxKey] !== "number") return "indeterminate";
      if ((producer[maxKey] as number) > aMax) return "incompatible";
    }
  }
  return "compatible";
}

/**
 * Compare an anchored prefix pattern (e.g. `^audio/`). Only handles the
 * anchored-literal-prefix case the contract names; anything else is
 * indeterminate.
 */
function compareAnchoredPattern(
  producer: Schema,
  acceptsPattern: string,
): AcceptsCompatibility {
  const acceptsPrefix = anchoredLiteralPrefix(acceptsPattern);
  if (acceptsPrefix === undefined) return "indeterminate";
  if (typeof producer.pattern === "string") {
    const producerPrefix = anchoredLiteralPrefix(producer.pattern);
    if (producerPrefix === undefined) return "indeterminate";
    return producerPrefix.startsWith(acceptsPrefix)
      ? "compatible"
      : "incompatible";
  }
  if (typeof producer.const === "string") {
    return producer.const.startsWith(acceptsPrefix)
      ? "compatible"
      : "incompatible";
  }
  return "indeterminate";
}

/** Extract a literal prefix from `^literal...` when the rest is plain text. */
function anchoredLiteralPrefix(pattern: string): string | undefined {
  if (!pattern.startsWith("^")) return undefined;
  const body = pattern.slice(1);
  // Stop at the first regex metacharacter — the literal run before it is a
  // safe lower bound on the required prefix.
  const meta = body.search(/[.*+?()[\]{}|\\$]/);
  return meta === -1 ? body : body.slice(0, meta);
}

function compareObjects(
  producer: Schema,
  accepts: Schema,
): AcceptsCompatibility {
  const aRequired = Array.isArray(accepts.required)
    ? (accepts.required as string[])
    : [];
  const pRequired = Array.isArray(producer.required)
    ? (producer.required as string[])
    : [];
  const pProps = (producer.properties as Record<string, Schema>) ?? {};
  // Every key accepts REQUIRES must be one the producer guarantees.
  for (const key of aRequired) {
    if (!pRequired.includes(key)) return "incompatible";
  }
  // accepts forbidding extra keys must be matched by the producer.
  if (accepts.additionalProperties === false) {
    if (producer.additionalProperties !== false) return "indeterminate";
    const aProps = (accepts.properties as Record<string, Schema>) ?? {};
    for (const key of Object.keys(pProps)) {
      if (!(key in aProps)) return "incompatible";
    }
  }
  // Recurse into shared properties.
  const aProps = (accepts.properties as Record<string, Schema>) ?? {};
  for (const key of Object.keys(aProps)) {
    if (key in pProps) {
      const nested = checkAcceptsCompatibility(pProps[key]!, aProps[key]!);
      if (nested === "incompatible") return "incompatible";
      if (nested === "indeterminate") return "indeterminate";
    }
  }
  return "compatible";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}
