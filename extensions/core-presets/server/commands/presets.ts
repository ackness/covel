import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { runtimePreset?: { id: string } }
  ) {
    return {
      content: context.runtimePreset?.id ?? "no preset"
    };
  },
  help: {
    usage: "/presets"
  }
};
