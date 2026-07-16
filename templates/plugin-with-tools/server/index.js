/**
 * Unified server entry (PLUGIN.md `entry`).
 *
 * Registers the plugin's local tools through the PluginAPI facade.
 * `covel.toolkit` carries the same injection bag ({ tool, z, shortId,
 * withPendingProposals, store, ... }) the tool factories expect.
 */
import makeRecordNote from "../tools/record-note.js";

/** @param {import('@covel/runtime').PluginAPI} covel */
export default function (covel) {
  covel.registerTool(makeRecordNote(covel.toolkit));
}
