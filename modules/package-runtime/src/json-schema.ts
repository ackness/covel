import { PackageRuntimeError } from "./error.js";

export interface JsonSchemaNode {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
}

export function parseJsonSchema(rawSchema: string, schemaPath: string): JsonSchemaNode {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawSchema);
  } catch {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `Invalid JSON schema at '${schemaPath}'.`,
      details: {
        schemaPath
      }
    });
  }

  if (!isPlainObject(parsed)) {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `JSON schema at '${schemaPath}' must be an object.`,
      details: {
        schemaPath
      }
    });
  }

  return parsed as JsonSchemaNode;
}

export function validateJsonSchemaValue(
  schema: JsonSchemaNode,
  value: unknown
): { ok: true } | { ok: false; error: string } {
  const error = validateNode(schema, value, "$");
  return error ? { ok: false, error } : { ok: true };
}

function validateNode(schema: JsonSchemaNode, value: unknown, path: string): string | null {
  switch (schema.type) {
    case "object":
      return validateObject(schema, value, path);
    case "array":
      return validateArray(schema, value, path);
    case "string":
      return typeof value === "string" ? null : `${path} must be a string.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number.`;
    case "integer":
      return Number.isInteger(value) ? null : `${path} must be an integer.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean.`;
    default:
      return null;
  }
}

function validateObject(schema: JsonSchemaNode, value: unknown, path: string): string | null {
  if (!isPlainObject(value)) {
    return `${path} must be an object.`;
  }

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (!(key in value)) {
      return `${path}.${key} is required.`;
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        return `${path}.${key} is not allowed.`;
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (!(key in value)) {
      continue;
    }
    const childError = validateNode(childSchema, value[key], `${path}.${key}`);
    if (childError) {
      return childError;
    }
  }

  return null;
}

function validateArray(schema: JsonSchemaNode, value: unknown, path: string): string | null {
  if (!Array.isArray(value)) {
    return `${path} must be an array.`;
  }

  if (!schema.items) {
    return null;
  }

  for (const [index, item] of value.entries()) {
    const itemError = validateNode(schema.items, item, `${path}[${index}]`);
    if (itemError) {
      return itemError;
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
