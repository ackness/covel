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
 * Only schema positions are visited: enum/const/default/examples hold data.
 * Throw if no single type can be described safely, so the caller can omit
 * the optional capability instead of breaking the entire model request.
 */
export function modelToolSchema(
  schema: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return toolParametersJsonSchema({
    toJSONSchema: () => normalizeNode(schema, "$"),
  });
}
