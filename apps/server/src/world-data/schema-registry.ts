import { readFile } from "node:fs/promises";
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import {
  formatValidationErrors,
  validateDimensions,
  type PluginDataSchemaDecl,
} from "@covel/shared";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import { resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const PLUGIN_SCHEMA_URI_RE =
  /^plugin:\/\/([a-z][a-z0-9-]*)\/([a-z][a-zA-Z0-9_-]{0,63})$/;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();

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

export interface BuiltinWorldDataSchemaRef {
  readonly kind: "builtin";
  readonly uri: "covel://world/dimensions";
}

export interface LocalWorldDataSchemaRef {
  readonly kind: "local";
  readonly uri: string;
  readonly path: string;
  readonly validate: ValidateFunction;
}

export type WorldDataSchemaRef =
  | BuiltinWorldDataSchemaRef
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
  const cached = validatorCache.get(options.cacheKey);
  if (cached) return cached;
  const raw = JSON.parse(await readFile(options.path, "utf-8")) as AnySchema;
  const validate = ajv.compile(raw);
  validatorCache.set(options.cacheKey, validate);
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
    const validation = validateDimensions(options.value);
    if (validation.valid) return null;
    return {
      level: "error",
      sourceId: options.source.id,
      schema: options.schema.uri,
      message: `invalid world dimensions:\n${formatValidationErrors(validation.errors ?? [])}`,
    };
  }

  if (!options.schema.validate) return null;
  if (options.schema.validate(options.value)) return null;
  return {
    level: "error",
    sourceId: options.source.id,
    schema: options.schema.uri,
    message: `${options.label ?? "worldData value"} failed schema validation: ${ajv.errorsText(options.schema.validate.errors)}`,
  };
}
