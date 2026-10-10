/**
 * Shared guard for framework-owned plugin-data namespaces.
 *
 * `_`-prefixed namespaces are framework bookkeeping, not plugin state:
 * `_runtime_jobs` drives background-job scheduling, while `_logs` is the
 * per-runtime log ring. Framework writers (the runtime job worker and runtime
 * logger) reach the store directly and stay privileged; every plugin-controlled write path — the REST
 * API, the `plugin.data` / `plugin.data.batch` commit handlers, the function
 * runtime's `ctx.pluginData`, and the RPC handler store view — routes through
 * this check so a plugin cannot fabricate or rewrite a job record.
 */
export function reservedPluginDataNamespaceError(
  namespace: string,
): string | null {
  if (namespace.startsWith("_")) {
    return `Namespace "${namespace}" is reserved for framework use and cannot be written by plugins`;
  }
  return null;
}

/**
 * World data imported from a `visibility: hidden` source lands in a reserved
 * per-namespace bucket. Only the receiving plugin's runtime code reads it; the
 * public plugin-data APIs, LLM-facing plugin-data tools, and prompt injection
 * never expose it. The owning plugin's code (function runtimes and its local
 * tools) may also write its own hidden buckets, so hidden content can grow as
 * the story develops; the REST API and the LLM plugin-data tools cannot.
 */
export const HIDDEN_PLUGIN_DATA_NAMESPACE_PREFIX = "_hidden.";

export function hiddenPluginDataNamespace(namespace: string): string {
  return `${HIDDEN_PLUGIN_DATA_NAMESPACE_PREFIX}${namespace}`;
}

export function isHiddenPluginDataNamespace(namespace: string): boolean {
  return namespace.startsWith(HIDDEN_PLUGIN_DATA_NAMESPACE_PREFIX);
}

/**
 * Write guard for plugin-authored proposals and function-runtime writes.
 * Writes are always keyed by the source plugin, so a plugin can only reach
 * its own hidden buckets; every other `_` namespace stays framework-only.
 */
export function pluginCodeNamespaceWriteError(
  namespace: string,
): string | null {
  if (isHiddenPluginDataNamespace(namespace)) return null;
  return reservedPluginDataNamespaceError(namespace);
}

/**
 * Framework bookkeeping that never travels with a snapshot or into a fork:
 * job rows are incarnation-bound execution state (copying them would let a
 * second worker see already-paid provider work as its own), and `_logs` is a
 * bounded diagnostic ring, not game state. `_jobs` names the retired
 * in-process queue's rows, which older databases and snapshots may still hold.
 */
const CONTROL_PLANE_NAMESPACES: ReadonlySet<string> = new Set([
  "_jobs",
  "_runtime_jobs",
  "_runtime_job_control",
  "_logs",
]);

export function isControlPlanePluginDataNamespace(namespace: string): boolean {
  return CONTROL_PLANE_NAMESPACES.has(namespace);
}

/**
 * Owner prefix of kernel bookkeeping rows in plugin data (`__kernel:vector`,
 * `__kernel:triggers`). It is an owner partition, never a plugin id: these rows
 * travel with snapshots but stay off every public plugin-data surface.
 */
export const KERNEL_PLUGIN_DATA_OWNER_PREFIX = "__kernel:";

export function isKernelPluginDataOwner(pluginId: string): boolean {
  return pluginId.startsWith(KERNEL_PLUGIN_DATA_OWNER_PREFIX);
}

/**
 * The shape `ctx.pluginData.list` hands to plugin code in every context: the
 * key, the value and the row's timestamps, without storage identifiers.
 */
export function pluginDataEntry(row: {
  readonly key: string;
  readonly value: unknown;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}): import("@covel/plugin-handlers-utils").PluginDataEntry {
  return {
    key: row.key,
    value: row.value,
    ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  };
}
