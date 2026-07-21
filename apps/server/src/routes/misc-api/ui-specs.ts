import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverPluginsMulti,
  loadPluginManifest,
  loadRuntimeUi,
  type PluginDiscoveryResult,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import {
  resolvePluginsDirs,
  UI_NAMESPACE_BY_SLOT,
  type UiSlotName,
} from "./shared.js";
import { partitionSlotSpecs, type UiSpecDiagnostic } from "./ui-spec-schema.js";

const UI_SLOTS = Object.keys(UI_NAMESPACE_BY_SLOT) as UiSlotName[];

type SlotSpecs = Partial<
  Record<UiSlotName, readonly Record<string, unknown>[]>
>;

interface RuntimeSlotSpecs {
  readonly runtimeIndex: number;
  readonly runtimeName: string;
  readonly slots: SlotSpecs;
}

interface PluginSlotSpecs {
  readonly pluginId: string;
  readonly runtimes: readonly RuntimeSlotSpecs[];
}

/** Loaded + validated UI specs for one plugins-dir layout at one signature. */
interface ValidatedSpecs {
  readonly signature: string;
  readonly discoveredIds: readonly string[];
  readonly pluginSpecs: readonly PluginSlotSpecs[];
  readonly diagnostics: readonly UiSpecDiagnostic[];
}

// ── Caches ─────────────────────────────────────────────────────────
//
// `discoverPluginsMulti` + `loadRuntime` (file read + JSON.parse) per request
// is wasteful — UI specs change only when a plugin file changes. We cache the
// fully-loaded+validated specs keyed by the plugins-dir layout, invalidated by
// a content signature derived from PLUGIN.md + ui/* file mtime/size (cheap
// `stat`, no read). `sessionSyncSignature` additionally suppresses the
// delete+rewrite of `plugin_data` rows on every request — only a changed
// signature (or a never-synced session) triggers the DB churn.
//
// vitest isolates each test file's module graph, so these maps reset per file.
const specCache = new Map<string, ValidatedSpecs>();
const sessionSyncSignature = new Map<string, string>();

/** Test-only: drop all caches so a test observes cold-start behaviour. */
export function __resetUiSpecsCache(): void {
  specCache.clear();
  sessionSyncSignature.clear();
}

async function statSignature(filePath: string): Promise<string> {
  try {
    const st = await fs.stat(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "0:0";
  }
}

/**
 * Content signature for the discovered plugin set. Invalidates when:
 *  - a plugin is added/removed (discovery set changes), or
 *  - a PLUGIN.md changes (its `ui:` declaration), or
 *  - any `ui/*` file is added/removed/edited (size or mtime moves).
 *
 * UI spec files live next to PLUGIN.md under `ui/` by convention, which every
 * bundled plugin follows; we shallow-`stat` that directory (no file reads).
 */
async function computeSignature(
  discoveries: readonly PluginDiscoveryResult[],
): Promise<string> {
  const hash = createHash("sha256");
  const sorted = [...discoveries].sort((a, b) => a.id.localeCompare(b.id));
  for (const discovery of sorted) {
    hash.update(`#${discovery.id}`);
    for (const mdPath of [...discovery.pluginMdPaths].sort()) {
      hash.update(`|md:${mdPath}:${await statSignature(mdPath)}`);
      const uiDir = path.join(path.dirname(mdPath), "ui");
      let names: string[] = [];
      try {
        names = (await fs.readdir(uiDir)).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const fp = path.join(uiDir, name);
        hash.update(`|ui:${fp}:${await statSignature(fp)}`);
      }
    }
  }
  return hash.digest("hex");
}

/**
 * Discover plugins, validate their UI specs, and cache the result keyed by the
 * plugins-dir layout. Reuses the cached value when the content signature is
 * unchanged, skipping `loadRuntime` + JSON parse + Zod validation entirely.
 */
async function loadValidatedSpecs(): Promise<ValidatedSpecs> {
  const dirs = resolvePluginsDirs();
  const dirsKey = dirs.join("::");
  const discoveries = await discoverPluginsMulti(dirs);
  const signature = await computeSignature(discoveries);

  const cached = specCache.get(dirsKey);
  if (cached && cached.signature === signature) return cached;

  const pluginSpecs: PluginSlotSpecs[] = [];
  const diagnostics: UiSpecDiagnostic[] = [];

  for (const discovery of discoveries) {
    const manifests = await loadPluginManifest(discovery);
    const runtimes: RuntimeSlotSpecs[] = [];

    for (const [runtimeIndex, parsed] of manifests.entries()) {
      // Only runtimes that declare a `ui:` block can contribute specs. Skipping
      // the rest mirrors the boot-time eager-load gate (bootstrap.ts) and avoids
      // loading — and possibly throwing on — the handler / guard / output-schema
      // of UI-irrelevant runtimes.
      if (!parsed.manifest.ui) continue;

      // A single bad runtime must never 500 the whole /api/ui-specs response.
      // Log with full context for fast triage, then skip it (mirrors the boot
      // eager-load try/catch). `loadRuntimeUi` loads manifest + UI spec data
      // only — it never import()s handler/guard JS, so an unapproved community
      // plugin's code cannot execute from this request path.
      const loaded = await loadRuntimeUi(discovery, parsed.manifest.name).catch(
        (err: unknown) => {
          console.error(
            `[ui-specs] Failed to load runtime "${discovery.id}/${parsed.manifest.name}" for UI specs:`,
            err,
          );
          return null;
        },
      );
      if (!loaded || !loaded.uiSpecs) continue;

      const slots: SlotSpecs = {};
      for (const slot of UI_SLOTS) {
        const specs = loaded.uiSpecs[slot];
        if (!specs || specs.length === 0) continue;
        const partition = partitionSlotSpecs({
          specs: specs as readonly Record<string, unknown>[],
          pluginId: discovery.id,
          runtimeId: loaded.manifest.name,
          slot,
        });
        diagnostics.push(...partition.diagnostics);
        if (partition.valid.length > 0) slots[slot] = partition.valid;
      }

      if (Object.keys(slots).length > 0) {
        runtimes.push({
          runtimeIndex,
          runtimeName: loaded.manifest.name,
          slots,
        });
      }
    }

    if (runtimes.length > 0) {
      pluginSpecs.push({ pluginId: discovery.id, runtimes });
    }
  }

  const value: ValidatedSpecs = {
    signature,
    discoveredIds: discoveries.map((d) => d.id),
    pluginSpecs,
    diagnostics,
  };
  specCache.set(dirsKey, value);
  return value;
}

/**
 * Materialise validated UI specs into `plugin_data` for a session, clearing
 * stale rows first so removed/edited specs don't linger. Operates on the
 * pre-loaded+validated specs — no extra file IO.
 */
async function syncUiSpecsToStore(
  sessionId: string,
  activePluginIds: ReadonlySet<string>,
  store: DataStore,
  loaded: ValidatedSpecs,
): Promise<void> {
  const now = new Date().toISOString();

  // Clear old cached specs for active+discovered plugins so hot-reloads /
  // removals don't leave stale blocks behind.
  for (const pluginId of loaded.discoveredIds) {
    if (!activePluginIds.has(pluginId)) continue;
    for (const namespace of Object.values(UI_NAMESPACE_BY_SLOT)) {
      const existing = await store.listPluginData(
        sessionId,
        pluginId,
        namespace,
      );
      for (const row of existing) {
        await store.deletePluginData(sessionId, pluginId, namespace, row.key);
      }
    }
  }

  const writes: Array<{
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }> = [];

  for (const plugin of loaded.pluginSpecs) {
    if (!activePluginIds.has(plugin.pluginId)) continue;
    for (const runtime of plugin.runtimes) {
      for (const slot of UI_SLOTS) {
        const specs = runtime.slots[slot];
        if (!specs || specs.length === 0) continue;
        writes.push({
          id: crypto.randomUUID(),
          sessionId,
          pluginId: plugin.pluginId,
          namespace: UI_NAMESPACE_BY_SLOT[slot],
          key: `${String(runtime.runtimeIndex).padStart(3, "0")}:${runtime.runtimeName}`,
          value: specs,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (writes.length > 0) {
    await store.setPluginDataBatch(writes);
  }
}

export async function buildUiSpecsResponse(params: {
  sessionId?: string;
  registry: PluginRegistry;
  store: DataStore;
}): Promise<{
  right: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
  message: Array<{
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  }>;
  left: Array<{ pluginId: string; specs: readonly Record<string, unknown>[] }>;
  diagnostics: UiSpecDiagnostic[];
}> {
  const { sessionId, registry, store } = params;
  type SlotEntry = {
    pluginId: string;
    specs: readonly Record<string, unknown>[];
  };
  const right: SlotEntry[] = [];
  const message: SlotEntry[] = [];
  const left: SlotEntry[] = [];
  const diagnostics: UiSpecDiagnostic[] = [];

  let activeFilter: Set<string> | null = null;
  if (sessionId) {
    const session = await store.getSession(sessionId);
    if (session) {
      activeFilter = new Set(session.activePlugins ?? []);
      const loaded = await loadValidatedSpecs();
      for (const diag of loaded.diagnostics) {
        if (activeFilter.has(diag.pluginId)) diagnostics.push(diag);
      }
      // Only rewrite plugin_data when nothing relevant changed — avoids
      // per-request DB churn. The gate keys on BOTH the spec content signature
      // and the session's active set, so enabling a plugin mid-session (same
      // files, new active id) still re-materialises its rows.
      const syncKey = `${loaded.signature}::${[...activeFilter]
        .sort()
        .join(",")}`;
      if (sessionSyncSignature.get(sessionId) !== syncKey) {
        await syncUiSpecsToStore(sessionId, activeFilter, store, loaded);
        sessionSyncSignature.set(sessionId, syncKey);
      }
    }
  }

  if (sessionId && activeFilter) {
    for (const pluginId of activeFilter) {
      const [rightRows, messageRows, leftRows] = await Promise.all([
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.right),
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.message),
        store.listPluginData(sessionId, pluginId, UI_NAMESPACE_BY_SLOT.left),
      ]);

      const toSpecs = (rows: typeof rightRows) =>
        rows
          .sort((a, b) => a.key.localeCompare(b.key))
          .flatMap((row) =>
            Array.isArray(row.value)
              ? (row.value as Record<string, unknown>[])
              : [],
          );

      const rightSpecs = toSpecs(rightRows);
      const messageSpecs = toSpecs(messageRows);
      const leftSpecs = toSpecs(leftRows);

      if (rightSpecs.length) right.push({ pluginId, specs: rightSpecs });
      if (messageSpecs.length) message.push({ pluginId, specs: messageSpecs });
      if (leftSpecs.length) left.push({ pluginId, specs: leftSpecs });
    }
  } else {
    const all = registry.getAll();
    for (const [, entry] of all) {
      if (entry.status === "error") continue;
      if (activeFilter && !activeFilter.has(entry.id)) continue;

      for (const [, loaded] of entry.loadedRuntimes) {
        if (!loaded.uiSpecs) continue;
        const pluginId = loaded.manifest.pluginId;
        const runtimeId = loaded.manifest.name;

        for (const slot of UI_SLOTS) {
          const specs = loaded.uiSpecs[slot];
          if (!specs || specs.length === 0) continue;
          const partition = partitionSlotSpecs({
            specs: specs as readonly Record<string, unknown>[],
            pluginId,
            runtimeId,
            slot,
          });
          diagnostics.push(...partition.diagnostics);
          if (partition.valid.length === 0) continue;
          const target =
            slot === "right" ? right : slot === "message" ? message : left;
          target.push({ pluginId, specs: partition.valid });
        }
      }
    }
  }

  return { right, message, left, diagnostics };
}
