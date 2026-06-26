import {
  COVEL_EVENT_META,
  PROPOSAL_TYPES,
  outputKindSchema,
  triggerTypeSchema,
  worldDataEffectSchema,
  worldDataMergeModeSchema,
  worldDataSourceKindSchema,
} from "@covel/shared";
import type { RuntimeManifest } from "@covel/shared";
import type {
  ParsedPluginMd,
  PluginRegistry,
  PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { DataStore, PluginDataRecord } from "@covel/store";

type JsonRecord = Record<string, unknown>;

export interface PluginManifestSummary {
  capabilities: string[];
  tags: string[];
  relations?: unknown;
  outputKind?: string;
}

export interface RuntimePluginContract {
  id: string;
  name: string;
  description?: unknown;
  runtimeType: string;
  outputKind: string;
  capabilities: string[];
  tags: string[];
  relations?: unknown;
  priority?: number;
  trigger?: unknown;
  execution?: unknown;
  model?: unknown;
  tools: {
    builtin: string[];
    local: Array<{ path: string; name: string }>;
  };
  input: {
    inject: unknown[];
    tools: unknown[];
  };
  output: JsonRecord;
  dataSchemas: string[];
  writablePluginDataNamespaces: string[];
  readablePluginDataNamespaces: string[];
  ui: {
    right: string[];
    message: string[];
    left: string[];
  };
  rpc: Array<{
    action: string;
    handler: string;
    input?: unknown;
    trustLevel?: string;
    streaming: boolean;
    description?: unknown;
  }>;
  hooks: unknown[];
  userSettings: unknown[];
}

export interface PluginDataSchemaContract {
  namespace: string;
  schemaVersion?: number;
  acceptsWorldData?: boolean;
  schema: unknown;
  description?: unknown;
}

export interface PluginContract {
  id: string;
  name: unknown;
  description?: unknown;
  pluginType?: string;
  runtimeCount: number;
  status: string;
  source?: string;
  rootPath?: string;
  capabilities: string[];
  tags: string[];
  relations?: unknown;
  dataSchemas: Record<string, PluginDataSchemaContract>;
  declaredPluginDataNamespaces: string[];
  tools: {
    builtin: string[];
    local: Array<{ runtimeId: string; path: string; name: string }>;
  };
  rpc: JsonRecord[];
  ui: {
    right: Array<{ runtimeId: string; path: string }>;
    message: Array<{ runtimeId: string; path: string }>;
    left: Array<{ runtimeId: string; path: string }>;
  };
  runtimes: RuntimePluginContract[];
}

export interface FrameworkCapabilities {
  schemaVersion: 1;
  framework: JsonRecord;
}

export interface PluginDataKeyIndex {
  key: string;
  createdAt: string;
  updatedAt: string;
  valueType: string;
}

export interface PluginDataNamespaceIndex {
  namespace: string;
  count: number;
  latestUpdatedAt?: string;
  keys: PluginDataKeyIndex[];
}

export interface SessionDiscoverySnapshot {
  framework: JsonRecord;
  plugins: PluginContract[];
  pluginData: Array<{
    pluginId: string;
    namespaces: PluginDataNamespaceIndex[];
  }>;
}

const DEFAULT_BUILTIN_TOOLS = [
  "render-ui",
  "create-form",
  "create-choices",
  "create-notification",
  "suspend",
  "runtime-done",
  "plugin-data-set",
  "plugin-data-set-batch",
  "plugin-data-get",
  "plugin-data-list",
  "create-character",
  "update-character",
  "get-character",
  "list-characters",
  "get-world-dimensions",
] as const;

// Proposal type list is derived from the single source of truth in
// @covel/shared (`PROPOSAL_TYPES`), which is exhaustiveness-checked against the
// commit-handler registry. Discovery therefore advertises exactly what the
// kernel can commit — no hand-maintained list, no drift.

// The advertised protocol event vocabulary is DERIVED from the single source
// of truth in @covel/shared (`COVEL_EVENT_META`, exhaustiveness-checked against
// the `CovelEvent` union). Discovery therefore advertises exactly the closed
// event set the kernel can emit — no hand-maintained list, no drift. (Asserted
// by apps/server/tests/api/covel-event-contract.test.ts.)

const WORLD_DATA_TARGET_URIS = [
  "world:metadata.<path>",
  "plugin:<pluginId>/<namespace>",
  "plugin:<pluginId>/<namespace>+lorebook",
  "lorebook",
  "characters",
  "media",
] as const;

const WORLD_DATA_SCHEMA_URIS = [
  "covel://world/dimensions",
  "plugin://<pluginId>/<namespace>",
  "<local-json-schema-path>",
] as const;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function enumValues<T extends string>(schema: { options: readonly T[] }): T[] {
  return [...schema.options];
}

function getManifestRecords(
  entry: PluginRegistryEntry,
): readonly ParsedPluginMd[] {
  return entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
}

export function summarizePluginManifests(
  entry: PluginRegistryEntry,
): PluginManifestSummary {
  const manifests = getManifestRecords(entry);
  const capabilities = Array.from(
    new Set(manifests.flatMap((m) => m.manifest.capabilities ?? [])),
  );
  const tags = uniqueSorted([
    ...(entry.summary.tags ?? []),
    ...manifests.flatMap((m) => m.manifest.tags ?? []),
  ]);
  const outputKind = entry.manifest?.manifest.outputKind;
  return {
    capabilities,
    tags,
    ...(entry.summary.relations ? { relations: entry.summary.relations } : {}),
    outputKind,
  };
}

function runtimeIdFromName(pluginId: string, runtimeName: string): string {
  return runtimeName === pluginId && !runtimeName.includes("/")
    ? pluginId
    : runtimeName;
}

function localToolName(path: string): string {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? path
  );
}

function buildRuntimeContract(
  pluginId: string,
  manifest: RuntimeManifest,
): RuntimePluginContract {
  const dataSchemaNamespaces = Object.keys(manifest.dataSchemas ?? {});
  const pluginDataInjectNamespaces =
    manifest.input?.inject
      ?.filter((inject) => inject.kind === "plugin-data")
      .map((inject) => inject.namespace) ?? [];
  const ui = {
    right: [...(manifest.ui?.right ?? [])],
    message: [...(manifest.ui?.message ?? [])],
    left: [...(manifest.ui?.left ?? [])],
  };

  return {
    id: runtimeIdFromName(pluginId, manifest.name),
    name: manifest.name,
    description: manifest.description,
    runtimeType: manifest.runtimeType ?? "agent",
    outputKind: manifest.outputKind ?? "plugin",
    capabilities: [...(manifest.capabilities ?? [])],
    tags: [...(manifest.tags ?? [])],
    ...(manifest.relations ? { relations: manifest.relations } : {}),
    ...(manifest.priority !== undefined ? { priority: manifest.priority } : {}),
    ...(manifest.trigger ? { trigger: manifest.trigger } : {}),
    ...(manifest.execution ? { execution: manifest.execution } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
    tools: {
      builtin: [...(manifest.tools?.builtin ?? [])],
      local: (manifest.tools?.local ?? []).map((path) => ({
        path,
        name: localToolName(path),
      })),
    },
    input: {
      inject: [...(manifest.input?.inject ?? [])],
      tools: [...(manifest.input?.tools ?? [])],
    },
    output: (manifest.output ?? {}) as JsonRecord,
    dataSchemas: dataSchemaNamespaces,
    writablePluginDataNamespaces: uniqueSorted([
      ...dataSchemaNamespaces,
      ...pluginDataInjectNamespaces,
    ]),
    readablePluginDataNamespaces: uniqueSorted(pluginDataInjectNamespaces),
    ui,
    rpc: Object.entries(manifest.rpc ?? {}).map(([action, decl]) => ({
      action,
      handler: decl.handler,
      ...(decl.input ? { input: decl.input } : {}),
      ...(decl.trustLevel ? { trustLevel: String(decl.trustLevel) } : {}),
      streaming: decl.streaming ?? false,
      ...(decl.description ? { description: decl.description } : {}),
    })),
    hooks: [...(manifest.hooks ?? [])],
    userSettings: [...(manifest.userSettings ?? [])],
  };
}

export function buildPluginContract(
  entry: PluginRegistryEntry,
): PluginContract {
  const runtimes = getManifestRecords(entry).map((parsed) =>
    buildRuntimeContract(entry.id, parsed.manifest),
  );
  const dataSchemas = Object.fromEntries(
    Object.entries(entry.dataSchemas ?? {}).map(([namespace, decl]) => [
      namespace,
      {
        namespace,
        schemaVersion: decl.schemaVersion,
        acceptsWorldData: decl.acceptsWorldData,
        schema: decl.schema,
        ...(decl.description ? { description: decl.description } : {}),
      },
    ]),
  );

  return {
    id: entry.id,
    name: entry.summary.name,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    runtimeCount: entry.summary.runtimeCount,
    status: entry.status,
    source: entry.source,
    rootPath: entry.rootPath,
    capabilities: uniqueSorted(
      runtimes.flatMap((runtime) => runtime.capabilities),
    ),
    tags: uniqueSorted([
      ...(entry.summary.tags ?? []),
      ...runtimes.flatMap((runtime) => runtime.tags),
    ]),
    ...(entry.summary.relations ? { relations: entry.summary.relations } : {}),
    dataSchemas,
    declaredPluginDataNamespaces: uniqueSorted([
      ...Object.keys(dataSchemas),
      ...runtimes.flatMap((runtime) => runtime.writablePluginDataNamespaces),
    ]),
    tools: {
      builtin: uniqueSorted(
        runtimes.flatMap((runtime) => runtime.tools.builtin),
      ),
      local: runtimes.flatMap((runtime) =>
        runtime.tools.local.map((tool) => ({ runtimeId: runtime.id, ...tool })),
      ),
    },
    rpc: runtimes.flatMap((runtime) =>
      runtime.rpc.map((action) => ({ runtimeId: runtime.id, ...action })),
    ),
    ui: {
      right: runtimes.flatMap((runtime) =>
        runtime.ui.right.map((path) => ({ runtimeId: runtime.id, path })),
      ),
      message: runtimes.flatMap((runtime) =>
        runtime.ui.message.map((path) => ({ runtimeId: runtime.id, path })),
      ),
      left: runtimes.flatMap((runtime) =>
        runtime.ui.left.map((path) => ({ runtimeId: runtime.id, path })),
      ),
    },
    runtimes,
  };
}

export function buildFrameworkCapabilities(
  builtinToolNames?: readonly string[],
): FrameworkCapabilities {
  return {
    schemaVersion: 1,
    framework: {
      pluginManifest: {
        triggerTypes: enumValues(triggerTypeSchema),
        outputKinds: enumValues(outputKindSchema),
        runtimeTypes: ["agent", "function"],
        executionModes: ["sync", "background"],
        inputInjectKinds: ["runtime", "plugin-data"],
        uiSlots: ["right", "message", "left"],
      },
      pluginData: {
        scope: "(sessionId, pluginId, namespace, key)",
        reservedNamespaces: [
          "_jobs",
          "_logs",
          "__ui_right__",
          "__ui_message__",
        ],
        writePaths: [
          "builtin-tool:plugin-data-set",
          "builtin-tool:plugin-data-set-batch",
          "function-output:pluginData[]",
          "local-tool:withPendingProposals(plugin.data)",
          "local-tool:withPendingProposals(plugin.data.batch)",
          "plugin-rpc:context.store.setPluginData",
          "management-api:PUT /api/sessions/:id/plugin-data/:pluginId/:namespace/:key",
        ],
        readPaths: [
          "builtin-tool:plugin-data-get",
          "builtin-tool:plugin-data-list",
          "input.inject:plugin-data",
          "function-ctx.store.getPluginData",
          "function-ctx.store.listPluginData",
          "management-api:GET /api/sessions/:id/plugin-data/:pluginId/:namespace",
        ],
      },
      tools: {
        builtin: uniqueSorted(builtinToolNames ?? DEFAULT_BUILTIN_TOOLS),
      },
      proposals: {
        types: PROPOSAL_TYPES,
        pluginDataTypes: ["plugin.data", "plugin.data.batch"],
      },
      protocol: {
        events: uniqueSorted(Object.keys(COVEL_EVENT_META)),
      },
      worldData: {
        sourceKinds: enumValues(worldDataSourceKindSchema),
        mergeModes: enumValues(worldDataMergeModeSchema),
        effects: enumValues(worldDataEffectSchema),
        targetUris: WORLD_DATA_TARGET_URIS,
        schemaUris: WORLD_DATA_SCHEMA_URIS,
      },
    },
  };
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function buildPluginDataIndex(
  records: readonly PluginDataRecord[],
): PluginDataNamespaceIndex[] {
  const byNamespace = new Map<
    string,
    {
      count: number;
      latestUpdatedAt?: string;
      keys: {
        key: string;
        createdAt: string;
        updatedAt: string;
        valueType: string;
      }[];
    }
  >();

  for (const record of records) {
    const bucket = byNamespace.get(record.namespace) ?? {
      count: 0,
      latestUpdatedAt: undefined,
      keys: [],
    };
    bucket.count += 1;
    bucket.keys.push({
      key: record.key,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      valueType: valueType(record.value),
    });
    if (!bucket.latestUpdatedAt || record.updatedAt > bucket.latestUpdatedAt) {
      bucket.latestUpdatedAt = record.updatedAt;
    }
    byNamespace.set(record.namespace, bucket);
  }

  return [...byNamespace.entries()]
    .map(([namespace, bucket]) => ({
      namespace,
      count: bucket.count,
      latestUpdatedAt: bucket.latestUpdatedAt,
      keys: bucket.keys.sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}

export async function buildSessionDiscoverySnapshot(options: {
  readonly store: DataStore;
  readonly registry?: PluginRegistry;
  readonly sessionId: string;
  readonly builtinToolNames?: readonly string[];
}): Promise<SessionDiscoverySnapshot> {
  const session = await options.store.getSession(options.sessionId);
  const activePluginIds = session?.activePlugins ?? [];
  const pluginEntries = options.registry
    ? activePluginIds
        .map((pluginId) => options.registry?.get(pluginId))
        .filter((entry): entry is PluginRegistryEntry => Boolean(entry))
    : [];

  return {
    framework: buildFrameworkCapabilities(options.builtinToolNames).framework,
    plugins: pluginEntries.map(buildPluginContract),
    pluginData: await Promise.all(
      activePluginIds.map(async (pluginId) => ({
        pluginId,
        namespaces: buildPluginDataIndex(
          await options.store.listPluginData(options.sessionId, pluginId),
        ),
      })),
    ),
  };
}
