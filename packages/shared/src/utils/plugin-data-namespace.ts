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
