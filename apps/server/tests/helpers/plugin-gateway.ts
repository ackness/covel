import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";

export type GenerateTextInput = Parameters<
  PluginRuntimeGateway["generateText"]
>[0];

/** A plugin gateway whose only working call is `generateText`. */
export function stubPluginGateway(
  generateText: PluginRuntimeGateway["generateText"],
): PluginRuntimeGateway {
  return {
    generateText,
    async generateObject() {
      throw new Error("generateObject is not expected in this test");
    },
    resolveSlot: () => null,
  };
}
