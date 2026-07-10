/**
 * Unified server entry (PLUGIN.md `entry`) — registers guide's local tool.
 */
import makeGenerateGuide from "../tools/generate-guide.js";

export default function (covel) {
  covel.registerTool(makeGenerateGuide(covel.toolkit));
}
