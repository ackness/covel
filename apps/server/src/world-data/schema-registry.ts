import { readFile } from "node:fs/promises";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  formatValidationErrors,
  validateWorldIRV1,
  validateDimensions,
  WORLD_IR_V1_SCHEMA_URI,
  type PluginDataSchemaDecl,
} from "@covel/shared";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import { sha256Hex } from "./digest.js";
import { resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const PLUGIN_SCHEMA_URI_RE =
  /^plugin:\/\/([a-z][a-z0-9-]*)\/([a-z][a-zA-Z0-9_-]{0,63})$/;

// Validators are recompiled when a schema file digest changes. Avoid Ajv's
// process-global `$id` registration so a legitimate hot reload of the same
// schema identity does not fail with "schema already exists".
const ajvDraft7 = new Ajv({
  allErrors: true,
  strict: false,
  addUsedSchema: false,
});
const ajvDraft2020 = new Ajv2020({
  allErrors: true,
  strict: false,
  addUsedSchema: false,
});
const validatorCache = new Map<
  string,
  { readonly digest: string; readonly validate: ValidateFunction }
>();

export interface WorldDataSchemaRegistryDeps {
  readonly registry?: Pick<PluginRegistry, "get">;
}

export interface PluginWorldDataSchemaRef {
  readonly kind: "plugin";
  readonly uri: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly entry: PluginRegistryEntry;
  readonly declaration: PluginDataSchemaDecl;
  readonly validate?: ValidateFunction;
}

export interface BuiltinDimensionsWorldDataSchemaRef {
  readonly kind: "builtin";
  readonly uri: "covel://world/dimensions";
}

export interface BuiltinWorldIRV1SchemaRef {
  readonly kind: "builtin";
  readonly uri: typeof WORLD_IR_V1_SCHEMA_URI;
}

export interface LocalWorldDataSchemaRef {
  readonly kind: "local";
  readonly uri: string;
  readonly path: string;
  readonly validate: ValidateFunction;
}

export type WorldDataSchemaRef =
  | BuiltinDimensionsWorldDataSchemaRef
  | BuiltinWorldIRV1SchemaRef
  | PluginWorldDataSchemaRef
  | LocalWorldDataSchemaRef;

export function parsePluginSchemaUri(
  uri: string,
): { pluginId: string; namespace: string } | null {
  const match = PLUGIN_SCHEMA_URI_RE.exec(uri);
  return match ? { pluginId: match[1]!, namespace: match[2]! } : null;
}

export function pluginSchemaUriForTarget(options: {
  readonly pluginId: string;
  readonly namespace: string;
}): string {
  return `plugin://${options.pluginId}/${options.namespace}`;
}

function getPluginEntry(
  deps: WorldDataSchemaRegistryDeps | undefined,
  pluginId: string,
): PluginRegistryEntry | undefined {
  return deps?.registry?.get(pluginId);
}

async function loadJsonSchemaValidator(options: {
  readonly cacheKey: string;
  readonly path: string;
}): Promise<ValidateFunction> {
  const text = await readFile(options.path, "utf-8");
  const digest = sha256Hex(text);
  const cached = validatorCache.get(options.cacheKey);
  if (cached?.digest === digest) return cached.validate;
  const raw = JSON.parse(text) as AnySchema;
  const dialect =
    typeof raw === "object" &&
    raw !== null &&
    "$schema" in raw &&
    typeof raw.$schema === "string"
      ? raw.$schema
      : undefined;
  const ajv = dialect?.includes("/draft/2020-12/schema")
    ? ajvDraft2020
    : ajvDraft7;
  const validate = ajv.compile(raw);
  validatorCache.set(options.cacheKey, { digest, validate });
  return validate;
}

async function resolvePluginSchema(
  uri: string,
  pluginId: string,
  namespace: string,
  deps: WorldDataSchemaRegistryDeps | undefined,
): Promise<WorldDataSchemaRef | WorldDataDiagnostic> {
  const entry = getPluginEntry(deps, pluginId);
  if (!entry) {
    return {
      level: "error",
      schema: uri,
      message: `worldData schema plugin "${pluginId}" is not registered`,
    };
  }
  const declaration = entry.dataSchemas?.[namespace];
  if (!declaration) {
    return {
      level: "error",
      schema: uri,
      message: `worldData schema plugin "${pluginId}" has no dataSchemas declaration for namespace "${namespace}"`,
    };
  }
  if (!declaration.schema) {
    return { kind: "plugin", uri, pluginId, namespace, entry, declaration };
  }
  if (!entry.rootPath) {
    throw new Error(
      `plugin "${pluginId}" data schema for namespace "${namespace}" cannot be resolved without a plugin root path`,
    );
  }
  const schemaPath = await resolveContainedPath(
    entry.rootPath,
    declaration.schema,
    {
      rejectSymlinks: true,
    },
  );
  if (!schemaPath) {
    throw new Error(
      `plugin "${pluginId}" data schema for namespace "${namespace}" is invalid or escapes plugin root`,
    );
  }
  const validate = await loadJsonSchemaValidator({
    cacheKey: `plugin:${entry.id}:${namespace}:${schemaPath}`,
    path: schemaPath,
  });
  return {
    kind: "plugin",
    uri,
    pluginId,
    namespace,
    entry,
    declaration,
    validate,
  };
}

export async function resolveWorldDataSchema(options: {
  readonly source: OrderedWorldDataSource;
  readonly deps?: WorldDataSchemaRegistryDeps;
}): Promise<WorldDataSchemaRef | WorldDataDiagnostic | null> {
  const uri = options.source.descriptor.schema;
  if (!uri) return null;
  if (uri === "covel://world/dimensions") {
    return { kind: "builtin", uri };
  }
  if (uri === WORLD_IR_V1_SCHEMA_URI) {
    return { kind: "builtin", uri };
  }

  const pluginRef = parsePluginSchemaUri(uri);
  if (pluginRef) {
    return resolvePluginSchema(
      uri,
      pluginRef.pluginId,
      pluginRef.namespace,
      options.deps,
    );
  }

  const schemaRoot =
    options.source.schemaOrigin?.descriptorRoot ??
    options.source.pathOrigin.descriptorRoot;
  const schemaPath = await resolveContainedPath(schemaRoot, uri, {
    rejectSymlinks: true,
  });
  if (!schemaPath) {
    return {
      level: "error",
      sourceId: options.source.id,
      schema: uri,
      message: `worldData schema path is invalid or escapes ${options.source.schemaOrigin?.origin ?? options.source.pathOrigin.origin} root: ${uri}`,
    };
  }
  const validate = await loadJsonSchemaValidator({
    cacheKey: `local:${schemaPath}`,
    path: schemaPath,
  });
  return { kind: "local", uri, path: schemaPath, validate };
}

export function validateWorldDataSchemaValue(options: {
  readonly schema: WorldDataSchemaRef;
  readonly source: OrderedWorldDataSource;
  readonly value: unknown;
  readonly label?: string;
}): WorldDataDiagnostic | null {
  if (options.schema.kind === "builtin") {
    const validation =
      options.schema.uri === WORLD_IR_V1_SCHEMA_URI
        ? validateWorldIRV1(options.value)
        : validateDimensions(options.value);
    if (validation.valid) return null;
    return {
      level: "error",
      sourceId: options.source.id,
      schema: options.schema.uri,
      message:
        options.schema.uri === WORLD_IR_V1_SCHEMA_URI
          ? `invalid WorldIRV1:\n${formatValidationErrors(validation.errors ?? [])}`
          : `invalid world dimensions:\n${formatValidationErrors(validation.errors ?? [])}`,
    };
  }

  if (!options.schema.validate) return null;
  if (options.schema.validate(options.value)) return null;
  return {
    level: "error",
    sourceId: options.source.id,
    schema: options.schema.uri,
    message: `${options.label ?? "worldData value"} failed schema validation: ${ajvDraft7.errorsText(options.schema.validate.errors)}`,
  };
}
