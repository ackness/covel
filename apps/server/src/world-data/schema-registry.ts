import { readFile } from "node:fs/promises";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  formatValidationErrors,
  validateDimensions,
  type PluginDataSchemaDecl,
} from "@covel/shared";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import { canonicalJson, sha256Hex } from "./digest.js";
import { resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

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
  readonly registry?: Pick<PluginRegistry, "get" | "getAll">;
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

export interface LocalWorldDataSchemaRef {
  readonly kind: "local";
  readonly uri: string;
  readonly path: string;
  readonly validate: ValidateFunction;
}

export type WorldDataSchemaRef =
  | BuiltinDimensionsWorldDataSchemaRef
  | PluginWorldDataSchemaRef
  | LocalWorldDataSchemaRef;

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

export async function resolvePluginSchema(
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

  if (uri.startsWith("plugin:"))
    return {
      level: "error",
      schema: uri,
      message: "World schema references must use contracts, not plugin IDs",
    };
  if (uri.startsWith("contract:")) {
    const contract = uri.slice("contract:".length);
    let selected: { path: string; canonical: string } | undefined;
    for (const [, entry] of options.deps?.registry?.getAll() ?? []) {
      const declaration = entry.packageManifest?.plugin?.contracts?.[contract];
      if (!declaration || !entry.rootPath) continue;
      const schemaPath = await resolveContainedPath(
        entry.rootPath,
        declaration.schema,
        { rejectSymlinks: true },
      );
      if (!schemaPath)
        return {
          level: "error",
          schema: uri,
          message: `Invalid schema path for contract "${contract}"`,
        };
      const canonical = canonicalJson(
        JSON.parse(await readFile(schemaPath, "utf-8")),
      );
      if (selected && selected.canonical !== canonical)
        return {
          level: "error",
          schema: uri,
          message: `Conflicting schemas for contract "${contract}"`,
        };
      selected = { path: schemaPath, canonical };
    }
    if (!selected) {
      // The source did not ask for this schema; it is the default of its
      // destination. A contract without a schema has nothing to check by.
      if (options.source.schemaImplicit) return null;
      return {
        level: "error",
        schema: uri,
        message: `No schema declared for contract "${contract}"`,
      };
    }
    return {
      kind: "local",
      uri,
      path: selected.path,
      validate: await loadJsonSchemaValidator({
        cacheKey: uri,
        path: selected.path,
      }),
    };
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

/**
 * The schema errors of the last value a validator rejected, one per entry:
 * the place in the value and what is wrong there.
 */
export function schemaErrorLines(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((error) =>
    `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim(),
  );
}

export function validateWorldDataSchemaValue(options: {
  readonly schema: WorldDataSchemaRef;
  readonly source: OrderedWorldDataSource;
  readonly value: unknown;
  readonly label?: string;
  /** The file, and the record in it, that `value` was read from. */
  readonly at?: Pick<WorldDataDiagnostic, "path" | "pointer">;
}): WorldDataDiagnostic | null {
  const at = {
    ...(options.at?.path ? { path: options.at.path } : {}),
    ...(options.at?.pointer ? { pointer: options.at.pointer } : {}),
  };
  if (options.schema.kind === "builtin") {
    const validation = validateDimensions(options.value);
    if (validation.valid) return null;
    return {
      level: "error",
      sourceId: options.source.id,
      ...at,
      schema: options.schema.uri,
      message: `invalid world dimensions:\n${formatValidationErrors(validation.errors ?? [])}`,
    };
  }

  if (!options.schema.validate) return null;
  if (options.schema.validate(options.value)) return null;
  return {
    level: "error",
    sourceId: options.source.id,
    ...at,
    schema: options.schema.uri,
    message: `${options.label ?? "worldData value"} failed schema validation: ${ajvDraft7.errorsText(options.schema.validate.errors)}`,
    hint:
      options.schema.kind === "local" &&
      !options.schema.uri.startsWith("contract:")
        ? `Change the record so that it fits ${options.schema.uri}.`
        : "Change the record so that it fits the data contract. `pnpm describe:authoring` shows the fields of each contract with an example.",
  };
}
