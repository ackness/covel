import { z } from "zod";

import { pickLocalizedText } from "../../../shared/locale.js";
import {
  createWorldSeedImportDraft,
  listWorldSeedSummaries
} from "../world-seeds.js";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([]),
    seed: z.string().optional()
  }),
  async execute(
    args: {
      _: string[];
      seed?: string;
    },
    context: {
      locale?: string;
    }
  ) {
    const seedId = args.seed ?? args._[0];

    if (!seedId) {
      const seeds = listWorldSeedSummaries(context.locale);
      const intro = pickLocalizedText(context.locale, {
        "zh-CN": `已暂存 ${seeds.length} 个世界种子：`,
        en: `${seeds.length} staged world seeds:`
      });
      const lines = seeds.map((seed) => {
        const localeLabel = pickLocalizedText(context.locale, {
          "zh-CN": `元数据 ${seed.metadataLocale} / 内容 ${seed.contentLocale}`,
          en: `metadata ${seed.metadataLocale} / content ${seed.contentLocale}`
        });

        return `- ${seed.name} (${seed.id}) [${localeLabel}]`;
      });
      const hint = pickLocalizedText(context.locale, {
        "zh-CN": "使用 /world-seeds --seed <id> 查看导入摘要。",
        en: "Use /world-seeds --seed <id> to inspect an import summary."
      });

      return {
        content: [intro, ...lines, "", hint].join("\n")
      };
    }

    let draft;
    try {
      draft = await createWorldSeedImportDraft({
        seedId,
        locale: context.locale
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown world seed")) {
        return {
          content: pickLocalizedText(context.locale, {
            "zh-CN": `未找到世界种子：${seedId}`,
            en: `Unknown world seed: ${seedId}`
          })
        };
      }

      throw error;
    }

    return {
      content: [
        `${pickLocalizedText(context.locale, {
          "zh-CN": "名称",
          en: "Name"
        })}: ${draft.world.name}`,
        `${pickLocalizedText(context.locale, {
          "zh-CN": "描述",
          en: "Description"
        })}: ${draft.world.description}`,
        `${pickLocalizedText(context.locale, {
          "zh-CN": "元数据语言",
          en: "Metadata locale"
        })}: ${draft.artifact.metadata.metadataLocale}`,
        `${pickLocalizedText(context.locale, {
          "zh-CN": "正文语言",
          en: "Content locale"
        })}: ${draft.artifact.metadata.contentLocale}`,
        `${pickLocalizedText(context.locale, {
          "zh-CN": "记忆条目数",
          en: "Memory documents"
        })}: ${draft.memoryDocuments.length}`,
        `${pickLocalizedText(context.locale, {
          "zh-CN": "旧能力提示",
          en: "Legacy capability hints"
        })}: ${draft.artifact.metadata.legacyCapabilityHints.join(", ")}`
      ].join("\n")
    };
  },
  help: {
    usage: "/world-seeds [seedId]",
    examples: [
      "/world-seeds",
      "/world-seeds --seed legacy-wuxia-nine-provinces"
    ]
  },
  autocomplete: {
    positionalHints: ["seedId"],
    flagHints: [
      {
        name: "--seed",
        description: "Inspect a staged world seed by id.",
        takesValue: true
      }
    ]
  }
};
