/**
 * Unified server entry (PLUGIN.md `entry`) — registers guide's local tool and
 * projects its latest suggestions into the stage choices slot.
 */
import makeGenerateGuide from "../tools/generate-guide.js";

export default function (covel) {
  covel.registerTool(makeGenerateGuide(covel.toolkit));
  covel.provideExtension("ui.slot@1", "choices", {
    async handler(_input, ctx) {
      const data = Object.fromEntries(
        (await ctx.pluginData.list("message")).map((row) => [
          row.key,
          row.value,
        ]),
      );
      const choices = [];
      for (let n = 1; n <= 6; n++) {
        const text = data[`prompt${n}Text`];
        if (typeof text !== "string" || !text.trim()) continue;
        const label = data[`prompt${n}Label`];
        choices.push({
          id: `prompt:${n}`,
          text: text.trim(),
          ...(label ? { label } : {}),
        });
      }
      return {
        choices,
        ...(typeof data.__turnId === "string" ? { turnId: data.__turnId } : {}),
        ...(data.scene ? { scene: data.scene } : {}),
        ...(data.recap ? { recap: data.recap } : {}),
        ...(data.decision ? { decision: data.decision } : {}),
      };
    },
  });
}
