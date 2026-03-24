import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { sessionId?: string }
  ) {
    return {
      content: context.sessionId ?? "no-session"
    };
  },
  help: {
    usage: "/session"
  }
};
