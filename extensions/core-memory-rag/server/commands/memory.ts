import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { ingestionRegistry?: { get(sourceKey: string): unknown }; locale?: string }
  ) {
    const marker = context.ingestionRegistry?.get("world:world_01");
    return {
      content: marker
        ? pickLocalizedText(context.locale, {
            "zh-CN": "已找到记忆标记",
            en: "Memory marker present"
          })
        : pickLocalizedText(context.locale, {
            "zh-CN": "未找到记忆标记",
            en: "Memory marker absent"
          })
    };
  },
  help: {
    usage: "/memory"
  }
};
