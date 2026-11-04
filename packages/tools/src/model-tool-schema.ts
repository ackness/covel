import { toolParametersJsonSchema } from "@covel/plugin-handlers-utils";

const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const schemaChildren = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);
const types = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function literalType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (["object", "string", "number", "boolean"].includes(type)) return type;
  throw new Error("non-JSON literal");
}

function commonType(values: readonly string[], path: string): string {
  const unique = new Set(values);
  if (unique.has("number")) unique.delete("integer");
  if (unique.size !== 1) throw new Error(`${path}: cannot infer a single type`);
  return [...unique][0]!;
}

/** Keywords whose values are data, never schemas: a `$ref` key there is a value. */
const dataKeywords = new Set(["enum", "const", "default", "examples"]);
/** Expanding shared definitions may repeat them; past this a schema is refused. */
const MAX_INLINED_NODES = 5000;

function resolvePointer(root: unknown, ref: string, path: string): unknown {
  if (ref !== "#" && !ref.startsWith("#/"))
    throw new Error(`${path}: only local references can be inlined`);
  let node = root;
  for (const raw of ref === "#" ? [] : ref.slice(2).split("/")) {
    const segment = decodeURIComponent(raw)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    if (!isObject(node) || !(segment in node))
      throw new Error(`${path}: reference ${ref} does not resolve`);
    node = node[segment];
  }
  return node;
}

/**
 * Replace local `#/...` references with the schemas they point to, so a model
 * provider never receives a dangling reference. Recursive definitions cannot
 * be written out and are refused, as are references to other documents.
 */
function inlineLocalReferences(root: Record<string, unknown>): unknown {
  let nodes = 0;
  const visit = (
    value: unknown,
    path: string,
    active: readonly string[],
  ): unknown => {
    if (Array.isArray(value))
      return value.map((child, index) =>
        visit(child, `${path}.${index}`, active),
      );
    if (!isObject(value)) return value;
    if ((nodes += 1) > MAX_INLINED_NODES)
      throw new Error(
        `${path}: schema is too large once references are inlined`,
      );
    if (path !== "$" && typeof value.$id === "string")
      throw new Error(
        `${path}.$id: nested schema identifiers cannot be inlined`,
      );
    const { $ref: ref, ...rest } = value;
    let base: Record<string, unknown> = {};
    if (ref !== undefined) {
      if (typeof ref !== "string")
        throw new Error(`${path}.$ref: expected a reference string`);
      if (active.includes(ref))
        throw new Error(
          `${path}.$ref: recursive reference ${ref} cannot be inlined`,
        );
      const target = visit(resolvePointer(root, ref, `${path}.$ref`), path, [
        ...active,
        ref,
      ]);
      if (!isObject(target))
        throw new Error(
          `${path}.$ref: reference ${ref} is not a schema object`,
        );
      base = target;
    }
    const node: Record<string, unknown> = { ...base };
    for (const [key, child] of Object.entries(rest)) {
      if (key === "$defs" || key === "definitions") continue;
      if (dataKeywords.has(key)) node[key] = child;
      // Names in a schema map are field names, not keywords.
      else if (schemaMaps.has(key) && isObject(child))
        node[key] = Object.fromEntries(
          Object.entries(child).map(([name, schema]) => [
            name,
            visit(schema, `${path}.${key}.${name}`, active),
          ]),
        );
      else node[key] = visit(child, `${path}.${key}`, active);
    }
    return node;
  };
  return visit(root, "$", []);
}

function normalizeNode(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${path}: expected a schema object`);
  const node = { ...value };
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      ["$ref", "$dynamicRef", "$recursiveRef", "$defs", "definitions"].includes(
        key,
      )
    )
      throw new Error(`${childPath}: references cannot be inlined`);
    if (key === "$schema" || key === "$id") {
      delete node[key];
    } else if (schemaMaps.has(key)) {
      if (!isObject(child))
        throw new Error(`${childPath}: expected a schema map`);
      node[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          normalizeNode(schema, `${childPath}.${name}`),
        ]),
      );
    } else if (schemaLists.has(key)) {
      if (!Array.isArray(child) || child.length === 0)
        throw new Error(`${childPath}: expected nonempty schema alternatives`);
      node[key] = child.map((schema, index) =>
        normalizeNode(schema, `${childPath}.${index}`),
      );
    } else if (schemaChildren.has(key)) {
      // Boolean additional/unevaluated properties are ordinary closed/open
      // object constraints, not schema nodes requiring an inferred type.
      if (
        typeof child === "boolean" &&
        [
          "additionalProperties",
          "unevaluatedProperties",
          "unevaluatedItems",
        ].includes(key)
      )
        continue;
      node[key] = normalizeNode(child, childPath);
    }
  }
  if ("enum" in node && (!Array.isArray(node.enum) || node.enum.length === 0))
    throw new Error(`${path}.enum: expected nonempty values`);
  if (node.type === undefined) {
    if ("const" in node) node.type = literalType(node.const);
    else if (Array.isArray(node.enum))
      node.type = commonType(node.enum.map(literalType), `${path}.enum`);
    else if (
      ["properties", "required", "additionalProperties"].some(
        (key) => key in node,
      )
    )
      node.type = "object";
    else if ("items" in node || "prefixItems" in node) node.type = "array";
    else {
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        const alternatives = node[key];
        if (Array.isArray(alternatives)) {
          node.type = commonType(
            alternatives.map((schema: Record<string, unknown>) =>
              String(schema.type),
            ),
            path,
          );
          break;
        }
      }
    }
  }
  if (typeof node.type !== "string" || !types.has(node.type))
    throw new Error(`${path}: no portable type can be inferred`);
  return node;
}

/**
 * Describe an author schema to a model without changing its validator.
 * Local references are written out first, so `$defs` in an author schema are
 * described in full. Only schema positions are visited: enum/const/default/
 * examples hold data.
 * Throw if no single type can be described safely, so the caller can omit
 * the optional capability instead of breaking the entire model request.
 */
export function modelToolSchema(
  schema: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return toolParametersJsonSchema({
    toJSONSchema: () => normalizeNode(inlineLocalReferences(schema), "$"),
  });
}
