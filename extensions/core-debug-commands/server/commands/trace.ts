import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute() {
    return {
      content: "Trace inspection available."
    };
  },
  help: {
    usage: "/trace"
  }
};
