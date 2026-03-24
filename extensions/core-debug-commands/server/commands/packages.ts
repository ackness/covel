import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: { packageRuntime?: { listPackages(): Array<{ name: string; enabled: boolean }> } }
  ) {
    const names = context.packageRuntime
      ?.listPackages()
      .filter((pkg) => pkg.enabled)
      .map((pkg) => pkg.name) ?? [];

    return {
      content: names.join(", ")
    };
  },
  help: {
    usage: "/packages"
  }
};
