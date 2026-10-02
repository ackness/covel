/**
 * Unified server entry (PLUGIN.md `entry`) — registers codex's local tool.
 */
import makeSyncCodexEntries from "../tools/sync-codex-entries.js";

export default function (covel) {
  covel.registerTool(makeSyncCodexEntries(covel.toolkit));
}
