/**
 * Unified server entry (PLUGIN.md `entry`) — registers codex's local tools.
 */
import makeUnlockCodexEntries from "../tools/unlock-codex-entries.js";
import makeUpdateCodexEntry from "../tools/update-codex-entry.js";

export default function (covel) {
  covel.registerTool(makeUnlockCodexEntries(covel.toolkit));
  covel.registerTool(makeUpdateCodexEntry(covel.toolkit));
}
