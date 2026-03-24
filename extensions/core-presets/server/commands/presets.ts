import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { runtimePreset?: { id: string }; locale?: string }
  ) {
    return {
      content: context.runtimePreset?.id ?? pickLocalizedText(context.locale, {
        "zh-CN": "当前没有可用预设",
        en: "No preset is currently available"
      })
    };
  },
  help: {
    usage: "/presets"
  }
};
