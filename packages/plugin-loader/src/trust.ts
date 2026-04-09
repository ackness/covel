/**
 * Plugin trust classification.
 */

import type { PluginSource, PluginTrustInfo } from './types.js';

/** Well-known builtin plugin ID prefixes. */
const BUILTIN_PREFIXES = ['core-'] as const;

/** Well-known official plugin IDs (extend as needed). */
const OFFICIAL_IDS = new Set<string>([]);

/**
 * Determine trust level for a plugin.
 *
 * - builtin (core-*): auto-load, no approval needed
 * - official (whitelist): auto-load, no approval needed
 * - community (everything else): requires user confirmation, tools need approval
 */
export function getPluginTrustInfo(pluginId: string, source?: PluginSource): PluginTrustInfo {
  const resolvedSource = source ?? detectSource(pluginId);

  switch (resolvedSource) {
    case 'builtin':
    case 'official':
      return {
        source: resolvedSource,
        autoLoad: true,
        requiresApproval: false,
      };
    case 'community':
      return {
        source: 'community',
        autoLoad: false,
        requiresApproval: true,
      };
  }
}

function detectSource(pluginId: string): PluginSource {
  for (const prefix of BUILTIN_PREFIXES) {
    if (pluginId.startsWith(prefix)) {
      return 'builtin';
    }
  }

  if (OFFICIAL_IDS.has(pluginId)) {
    return 'official';
  }

  return 'community';
}
