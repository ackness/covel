import {
  COVEL_EVENT_META,
  PROPOSAL_TYPES,
  WORLD_IR_V1_JSON_SCHEMA,
  WORLD_IR_V1_SCHEMA_URI,
  inputInjectDeclSchema,
  outputKindSchema,
  triggerTypeSchema,
  worldDataEffectSchema,
  worldDataMergeModeSchema,
  worldDataSourceKindSchema,
} from "@covel/shared";
import type { PluginDetail } from "@covel/shared";
import { resolveEffectsPolicy } from "@covel/runtime";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import type { DataStore, PluginDataRecord } from "@covel/store";
import { buildPluginDetail } from "../../lib/plugin-descriptor.js";

type JsonRecord = Record<string, unknown>;

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
  plugins: PluginDetail[];
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
  WORLD_IR_V1_SCHEMA_URI,
  "plugin://<pluginId>/<namespace>",
  "<local-json-schema-path>",
] as const;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function enumValues<T extends string>(schema: { options: readonly T[] }): T[] {
  return [...schema.options];
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
        turnCompletionModes: ["await", "detached"],
        // Derived from the inject discriminated union so a new kind
        // (e.g. runtime-export) can never go missing from the advert.
        inputInjectKinds: inputInjectDeclSchema.options.map(
          (option) => option.shape.kind.value,
        ),
        uiSlots: ["right", "message", "left"],
      },
      scheduling: {
        effectsPolicy: resolveEffectsPolicy(),
      },
      pluginData: {
        scope: "(sessionId, pluginId, namespace, key)",
        reservedNamespaces: ["_jobs", "_runtime_jobs", "_logs"],
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
        schemas: {
          [WORLD_IR_V1_SCHEMA_URI]: WORLD_IR_V1_JSON_SCHEMA,
        },
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
    plugins: pluginEntries.map(buildPluginDetail),
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
