import { z } from "zod";
import type { LLMProviderWarning } from "@covel/shared";
import type { ToolDefinition } from "../types.js";

// This describes a verified endpoint's limits, not a universal strict dialect.
// No provider profile is bundled until its current specification is verified.
export const strictToolProfileSchema = z.strictObject({
  id: z.string().min(1),
  keywords: z.array(
    z.enum([
      "$schema",
      "$id",
      "$defs",
      "definitions",
      "$ref",
      "$comment",
      "title",
      "description",
      "default",
      "examples",
      "deprecated",
      "readOnly",
      "writeOnly",
      "type",
      "enum",
      "const",
      "properties",
      "required",
      "additionalProperties",
      "patternProperties",
      "propertyNames",
      "minProperties",
      "maxProperties",
      "items",
      "prefixItems",
      "additionalItems",
      "contains",
      "minContains",
      "maxContains",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "anyOf",
      "oneOf",
      "allOf",
      "not",
      "if",
      "then",
      "else",
      "dependentRequired",
      "dependentSchemas",
      "dependencies",
      "unevaluatedProperties",
      "unevaluatedItems",
    ]),
  ),
  root: z.enum(["object", "any"]),
  requireAllProperties: z.boolean(),
  closedObjects: z.boolean(),
  references: z.enum(["none", "local", "recursive"]),
  typeUnions: z.boolean(),
  booleanSchemas: z.boolean(),
  formats: z.array(z.string()),
  maxBytes: z.number().int().positive(),
  maxDepth: z.number().int().positive().max(128),
  maxProperties: z.number().int().nonnegative(),
  maxEnumValues: z.number().int().nonnegative(),
});

/** Exact scope prevents a compatible protocol or routed model ID granting strict. */
export const strictToolCapabilitySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  protocol: z.string().min(1),
  baseUrl: z.string().url(),
  profile: strictToolProfileSchema,
});
export type StrictToolProfile = z.infer<typeof strictToolProfileSchema>;
export type StrictToolCapability = z.infer<typeof strictToolCapabilitySchema>;

export interface StrictSchemaIssue {
  readonly path: string;
  readonly reason: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (path: string, key: string) =>
  `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** Inspect without rewriting: optional fields, maps and constraints keep their meaning. */
export function checkStrictToolSchema(
  schema: Record<string, unknown>,
  profile: StrictToolProfile,
): { compatible: boolean; issues: StrictSchemaIssue[] } {
  const issues: StrictSchemaIssue[] = [];
  const issue = (path: string, reason: string) => {
    if (issues.length < 8) issues.push({ path: path.slice(0, 200), reason });
  };
  try {
    if (
      new TextEncoder().encode(JSON.stringify(schema)).length > profile.maxBytes
    )
      issue("#", "schema exceeds profile byte limit");
  } catch {
    issue("#", "schema is not JSON serializable");
    return { compatible: false, issues };
  }
  if (
    profile.root === "object" &&
    (schema.type !== "object" ||
      ["anyOf", "oneOf", "allOf", "$ref"].some((key) => key in schema))
  )
    issue("#", "profile requires an object root without composition");
  const keywords = new Set<string>(profile.keywords);
  let properties = 0;
  let enumValues = 0;
  let visits = 0;
  const walk = (
    node: unknown,
    path: string,
    depth: number,
    refs: ReadonlySet<string>,
  ) => {
    if (issues.length >= 8) return;
    if (++visits > 10000) {
      issue(path, "schema traversal exceeds checker limit");
      return;
    }
    if (
      properties > profile.maxProperties ||
      enumValues > profile.maxEnumValues
    )
      return;
    if (depth > profile.maxDepth) {
      issue(path, "schema exceeds profile depth limit");
      return;
    }
    if (typeof node === "boolean") {
      if (!profile.booleanSchemas)
        issue(path, "boolean schemas are unsupported");
      return;
    }
    if (!record(node)) {
      issue(path, "expected a schema object");
      return;
    }
    for (const key of Object.keys(node))
      if (!keywords.has(key))
        issue(pointer(path, key), "keyword is unsupported");
    if (Array.isArray(node.type) && !profile.typeUnions)
      issue(pointer(path, "type"), "type unions are unsupported");
    if (
      typeof node.format === "string" &&
      !profile.formats.includes(node.format)
    )
      issue(pointer(path, "format"), "format is unsupported");
    if (Array.isArray(node.enum)) enumValues += node.enum.length;
    if (
      node.type === "object" ||
      (Array.isArray(node.type) && node.type.includes("object")) ||
      node.properties !== undefined ||
      node.additionalProperties !== undefined ||
      node.patternProperties !== undefined
    ) {
      if (profile.closedObjects && node.additionalProperties !== false)
        issue(
          pointer(path, "additionalProperties"),
          "profile requires a closed object",
        );
      if (record(node.properties)) {
        properties += Object.keys(node.properties).length;
        const required = new Set(
          Array.isArray(node.required) ? node.required : [],
        );
        if (profile.requireAllProperties)
          for (const key of Object.keys(node.properties))
            if (!required.has(key))
              issue(
                pointer(pointer(path, "properties"), key),
                "optional property is unsupported",
              );
      }
    }
    if (node.$ref !== undefined) {
      const ref = node.$ref;
      if (profile.references === "none")
        issue(pointer(path, "$ref"), "references are unsupported");
      else if (
        typeof ref !== "string" ||
        (ref !== "#" && !ref.startsWith("#/"))
      )
        issue(pointer(path, "$ref"), "only local JSON pointers are supported");
      else if (refs.has(ref)) {
        if (profile.references !== "recursive")
          issue(pointer(path, "$ref"), "recursive references are unsupported");
      } else {
        let target: unknown = schema;
        for (const part of ref.slice(2).split("/")) {
          if (ref === "#") break;
          const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
          target =
            record(target) && Object.hasOwn(target, key)
              ? target[key]
              : undefined;
        }
        walk(target, pointer(path, "$ref"), depth + 1, new Set([...refs, ref]));
      }
    }
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
      "dependencies",
    ]) {
      if (record(node[key]))
        for (const [name, child] of Object.entries(node[key])) {
          if (key === "dependencies" && Array.isArray(child)) continue;
          walk(child, pointer(pointer(path, key), name), depth + 1, refs);
        }
    }
    for (const key of [
      "additionalProperties",
      "additionalItems",
      "items",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "unevaluatedProperties",
      "unevaluatedItems",
    ])
      if (node[key] !== undefined) {
        // A false additionalProperties is an object policy, even on profiles
        // that do not admit standalone boolean schemas.
        if (key === "additionalProperties" && typeof node[key] === "boolean")
          continue;
        if (key === "items" && Array.isArray(node[key]))
          issue(pointer(path, key), "tuple items require prefixItems");
        else walk(node[key], pointer(path, key), depth + 1, refs);
      }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
      if (Array.isArray(node[key]))
        for (const [index, child] of node[key].entries())
          walk(
            child,
            pointer(pointer(path, key), String(index)),
            depth + 1,
            refs,
          );
  };
  if (!issues.length) walk(schema, "#", 1, new Set());
  if (properties > profile.maxProperties)
    issue("#", "schema exceeds profile property limit");
  if (enumValues > profile.maxEnumValues)
    issue("#", "schema exceeds profile enum limit");
  return { compatible: issues.length === 0, issues };
}

export interface StrictToolTarget {
  readonly provider: string;
  readonly model: string;
  readonly protocol: string;
  readonly baseUrl?: string;
}

/** Called for each actual target, including programmatic adapters and fallbacks. */
export function selectStrictTools(
  tools: ToolDefinition[] | undefined,
  capability: StrictToolCapability | undefined,
  target: StrictToolTarget,
  usesBuiltinAdapter: boolean,
): { tools: ToolDefinition[] | undefined; warnings: LLMProviderWarning[] } {
  const warnings: LLMProviderWarning[] = [];
  const supportedWire =
    !usesBuiltinAdapter ||
    ["openai-chat-v1", "openai-responses-v1", "anthropic-messages-v1"].includes(
      target.protocol,
    );
  const scoped =
    capability &&
    supportedWire &&
    capability.provider === target.provider &&
    capability.model === target.model &&
    capability.protocol === target.protocol &&
    capability.baseUrl === target.baseUrl;
  return {
    tools: tools?.map((tool) => {
      if (tool.strict !== "auto") return tool;
      const checked = scoped
        ? checkStrictToolSchema(
            tool.function.parameters ?? {},
            capability.profile,
          )
        : undefined;
      if (checked && !checked.compatible && capability)
        warnings.push({
          type: "compatibility",
          feature: "strictTools",
          message: `Strict tool schema is incompatible with ${capability.profile.id}: ${checked.issues.map((entry) => `${entry.path}: ${entry.reason}`).join("; ")}`,
        });
      if (!checked)
        warnings.push({
          type: "unsupported",
          feature: "strictTools",
          message:
            "No verified strict tool profile for this target and wire; non-strict tools retain host validation.",
        });
      const { strict: _policy, ...definition } = tool;
      return {
        ...definition,
        function: { ...tool.function, strict: checked?.compatible === true },
      };
    }),
    warnings,
  };
}
