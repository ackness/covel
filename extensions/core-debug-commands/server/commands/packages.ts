import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([])
  }),
  async execute(
    _args: { _: string[] },
    context: {
      locale?: string;
      packageRuntime?: { listPackages(): Array<{ name: string; enabled: boolean }> };
    }
  ) {
    const names = context.packageRuntime
      ?.listPackages()
      .filter((pkg) => pkg.enabled)
      .map((pkg) => pkg.name) ?? [];

    return {
      content: names.length > 0
        ? names.join(", ")
        : pickLocalizedText(context.locale, {
            "zh-CN": "当前没有已启用的扩展包。",
            en: "No enabled packages."
          })
    };
  },
  help: {
    usage: "/packages"
  }
};
