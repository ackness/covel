import type { RuntimeManifest } from "../types/plugin.js";
import type { LoadedRuntime } from "./loaded-runtime.js";

export const SUBMIT_OUTPUT_TOOL_NAME = "submit-output";

/** Business work is independent of submission and never terminates an agent. */
export interface RequiredAgentWork {
  readonly required: boolean;
  /** Empty means any authorized business tool; otherwise one listed tool must succeed. */
  readonly toolNames: readonly string[];
}

export interface EffectiveAgentOutput {
  readonly toolName: typeof SUBMIT_OUTPUT_TOOL_NAME;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly schemaSource: "loaded" | "host-story" | "host-system";
  readonly provenance: "model-authored";
  readonly requiredWork: RequiredAgentWork;
}

export function requiredAgentWork(
  manifest: Pick<RuntimeManifest, "requireToolUse" | "completeAfterTools">,
): RequiredAgentWork {
  const toolNames = Object.freeze([...(manifest.completeAfterTools ?? [])]);
  if (toolNames.length && manifest.requireToolUse === false)
    throw new Error(
      "completeAfterTools implies requireToolUse; false is contradictory",
    );
  return Object.freeze({
    required: manifest.requireToolUse === true || toolNames.length > 0,
    toolNames,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require an object root, including local references and object intersections. */
export function assertAgentOutputObjectSchema(
  schema: unknown,
): asserts schema is Record<string, unknown> {
  const objectRoot = (node: unknown, seen: ReadonlySet<unknown>): boolean => {
    if (!record(node) || seen.has(node)) return false;
    const visited = new Set([...seen, node]);
    if (
      node.type === "object" ||
      (Array.isArray(node.type) &&
        node.type.length === 1 &&
        node.type[0] === "object")
    )
      return true;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      let target: unknown = schema;
      for (const key of node.$ref.slice(2).split("/")) {
        const decoded = key.replace(/~1/g, "/").replace(/~0/g, "~");
        target =
          record(target) && Object.hasOwn(target, decoded)
            ? target[decoded]
            : undefined;
      }
      if (objectRoot(target, visited)) return true;
    }
    if (
      Array.isArray(node.allOf) &&
      node.allOf.some((part) => objectRoot(part, visited))
    )
      return true;
    return [node.anyOf, node.oneOf].some(
      (parts) =>
        Array.isArray(parts) &&
        parts.length > 0 &&
        parts.every((part) => objectRoot(part, visited)),
    );
  };
  if (!objectRoot(schema, new Set()))
    throw new Error(
      "io.output.schema: submit-output parameters must describe an object; scalar, array and unconstrained roots are not supported",
    );
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

const storySchema = {
  type: "object",
  properties: {
    narrativeOutput: { type: "string", pattern: "\\S" },
    yield: { type: "string", enum: ["user", "continue"] },
  },
  required: ["narrativeOutput"],
};
const systemSchema = {
  type: "object",
  properties: {
    narrativeOutput: { type: "string" },
    completion: { type: "string", enum: ["done", "pending"] },
    preGameDone: { type: "boolean" },
  },
  additionalProperties: true,
};
const effectiveOutputs = new WeakMap<LoadedRuntime, EffectiveAgentOutput>();

/** Resolve once from the admitted artifact, before context and tool advertisement. */
export function resolveAgentOutput(
  loaded: LoadedRuntime,
): EffectiveAgentOutput {
  if (loaded.manifest.runtimeType === "function")
    throw new Error(
      "Function runtimes return handler output and cannot use submit-output",
    );
  const existing = effectiveOutputs.get(loaded);
  if (existing) return existing;
  if (loaded.manifest.output?.schema && !loaded.outputSchema)
    throw new Error("io.output.schema: declared schema was not loaded");
  const declared =
    loaded.outputSchema !== undefined
      ? loaded.outputSchema
      : loaded.outputContractSchema;
  const story = loaded.manifest.outputKind === "story";
  const schema =
    declared !== undefined ? declared : story ? storySchema : systemSchema;
  assertAgentOutputObjectSchema(schema);
  const output: EffectiveAgentOutput = Object.freeze({
    toolName: SUBMIT_OUTPUT_TOOL_NAME,
    schema: freezeJson(structuredClone(schema)),
    schemaSource: declared ? "loaded" : story ? "host-story" : "host-system",
    provenance: "model-authored",
    requiredWork: requiredAgentWork(loaded.manifest),
  });
  effectiveOutputs.set(loaded, output);
  return output;
}
