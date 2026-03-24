import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { sessionId?: string; locale?: string }
  ) {
    return {
      content: context.sessionId ?? pickLocalizedText(context.locale, {
        "zh-CN": "当前没有活动会话",
        en: "No active session"
      })
    };
  },
  help: {
    usage: "/session"
  }
};
