import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { ingestionRegistry?: { get(sourceKey: string): unknown } }
  ) {
    const marker = context.ingestionRegistry?.get("world:world_01");
    return {
      content: marker ? "memory marker present" : "memory marker absent"
    };
  },
  help: {
    usage: "/memory"
  }
};
