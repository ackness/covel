/**
 * Unified server entry (PLUGIN.md `entry`) — registers director's
 * lifecycle hook.
 */
import injectPreamble from "../hooks/inject-preamble.js";

export default function (covel) {
  covel.on("PostContextAssembly", injectPreamble);
}
