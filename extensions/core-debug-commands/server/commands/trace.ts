import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(_args: { _: string[] }, context: { locale?: string }) {
    return {
      content: pickLocalizedText(context.locale, {
        "zh-CN": "可查看最近的追踪记录。",
        en: "Trace inspection available."
      })
    };
  },
  help: {
    usage: "/trace"
  }
};
