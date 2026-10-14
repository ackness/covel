/**
 * The ID that names the framework itself where a plugin ID is expected: the
 * framework's own RPC actions and slash commands, and proposals the API
 * writes. No plugin package may take it (`pluginManifestSchema` rejects it),
 * so a request that names it always reaches the framework.
 */
export const FRAMEWORK_PLUGIN_ID = "framework";
