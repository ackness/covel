import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([]),
    mode: z.enum(["create"]).optional()
  }),
  async execute(
    _args: { _: string[]; mode?: "create" },
    context: { sessionId?: string; archiveService?: { createSnapshot(input: {
      sessionId: string;
      turnCutoff: number;
      stateSnapshot: Record<string, unknown>;
      workingSummary: string;
      archiveSummary: string;
    }): Promise<{ version: { id: string } }> } }
  ) {
    if (!context.sessionId || !context.archiveService) {
      return {
        content: "archive package could not resolve an active session"
      };
    }

    const snapshot = await context.archiveService.createSnapshot({
      sessionId: context.sessionId,
      turnCutoff: 0,
      stateSnapshot: {},
      workingSummary: "Working summary",
      archiveSummary: "Archive summary"
    });

    return {
      content: `archive ${snapshot.version.id} created`
    };
  },
  help: {
    usage: "/archive"
  }
};
