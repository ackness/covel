/**
 * Unified server entry (PLUGIN.md `entry`) — registers scene-prompts' local tool.
 */
import makeGenerateScenePrompts from "../tools/generate-scene-prompts.js";

export default function (covel) {
  covel.registerTool(makeGenerateScenePrompts(covel.toolkit));
}
