import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([]),
    mode: z.enum(["create"]).optional()
  }),
  async execute(
    _args: { _: string[]; mode?: "create" },
    context: { sessionId?: string; locale?: string; archiveService?: { createSnapshot(input: {
      sessionId: string;
      turnCutoff: number;
      stateSnapshot: Record<string, unknown>;
      workingSummary: string;
      archiveSummary: string;
    }): Promise<{ version: { id: string } }> } }
  ) {
    if (!context.sessionId || !context.archiveService) {
      return {
        content: pickLocalizedText(context.locale, {
          "zh-CN": "归档扩展无法解析当前活动会话。",
          en: "Archive package could not resolve an active session."
        })
      };
    }

    const snapshot = await context.archiveService.createSnapshot({
      sessionId: context.sessionId,
      turnCutoff: 0,
      stateSnapshot: {},
      workingSummary: pickLocalizedText(context.locale, {
        "zh-CN": "工作摘要",
        en: "Working summary"
      }),
      archiveSummary: pickLocalizedText(context.locale, {
        "zh-CN": "归档摘要",
        en: "Archive summary"
      })
    });

    return {
      content: pickLocalizedText(context.locale, {
        "zh-CN": `已创建归档 ${snapshot.version.id}`,
        en: `Archive ${snapshot.version.id} created`
      })
    };
  },
  help: {
    usage: "/archive"
  }
};
