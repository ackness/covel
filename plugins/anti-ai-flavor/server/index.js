/**
 * Unified server entry (PLUGIN.md `entry`) — registers anti-ai-flavor's
 * lifecycle hook.
 */
import injectStyleRules from "../hooks/inject-style-rules.js";

export default function (covel) {
  covel.on("PostContextAssembly", injectStyleRules);
}
