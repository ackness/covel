/**
 * Unified server entry (PLUGIN.md `entry`) — registers story-guard's
 * lifecycle hooks.
 */
import sanitizeResponse from "../hooks/sanitize-response.js";
import guardTool from "../hooks/guard-tool.js";

export default function (covel) {
  covel.on("PostLLMResponse", sanitizeResponse);
  covel.on("PreToolUse", guardTool);
}
