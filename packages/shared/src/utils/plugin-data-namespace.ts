/**
 * Shared guard for framework-owned plugin-data namespaces.
 *
 * `_`-prefixed namespaces are framework bookkeeping, not plugin state:
 * `_jobs` drives background-job scheduling and `_logs` is the per-runtime log
 * ring. Framework writers (the job runner, the runtime logger) reach the store
 * directly and stay privileged; every plugin-controlled write path — the REST
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
