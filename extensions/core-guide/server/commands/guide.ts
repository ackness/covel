import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([]),
    topic: z.string().optional()
  }),
  async execute(args: { _: string[]; topic?: string }, context: { locale?: string }) {
    const locale = context.locale;
    const topic = args.topic ?? args._[0] ?? pickLocalizedText(locale, {
      "zh-CN": "当前目标",
      en: "current objective"
    });

    return {
      content: pickLocalizedText(locale, {
        "zh-CN": `引导扩展已为 ${topic} 准备好选项。`,
        en: `Guide package prepared options for ${topic}.`
      }),
      blocks: [
        {
          id: "blk_guide",
          type: "choices",
          version: "1.0",
          meta: {
            package: "core-guide",
            requestId: "req_guide",
            traceId: "tr_guide",
            sessionId: "ses_guide",
            turnId: "turn_guide"
          },
          interaction: {
            requiresResponse: true,
            responseSchema: "schemas/blocks/choices.response.json",
            submitAs: "block_response",
            resumePolicy: "resume_current_flow"
          },
          data: {
            title: pickLocalizedText(locale, {
              "zh-CN": `${topic} 的下一步`,
              en: `Next move for ${topic}`
            }),
            options: [
              {
                id: "opt_a",
                label: pickLocalizedText(locale, {
                  "zh-CN": "继续前进",
                  en: "Advance"
                })
              },
              {
                id: "opt_b",
                label: pickLocalizedText(locale, {
                  "zh-CN": "观察周围",
                  en: "Observe"
                })
              }
            ]
          }
        }
      ]
    };
  },
  help: {
    usage: "/guide [topic]"
  },
  autocomplete: {
    positionalHints: ["topic"]
  }
};
