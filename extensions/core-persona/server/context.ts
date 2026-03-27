import type {
  PackageContextFragment,
  PackageContextProviderExecutionContext,
  PackageContextProviderInput
} from "../../../modules/package-runtime/src/index.js";
import { pickLocalizedText } from "../../shared/locale.js";

export const contextProvider = {
  id: "persona-context",
  async build(
    input: PackageContextProviderInput,
    context: PackageContextProviderExecutionContext
  ): Promise<PackageContextFragment[]> {
    const world = context.world;
    const style = inferNarrationStyle(world?.name ?? "", world?.description ?? "");

    return [
      {
        id: "narrator-persona",
        title: pickLocalizedText(input.locale, {
          "zh-CN": "叙事人格",
          en: "Narrator persona"
        }),
        content: pickLocalizedText(input.locale, {
          "zh-CN": [
            "保持冷静、具体、可落地的主持人口吻，优先描写玩家可观察到的事实。",
            "用 2 到 4 个足够鲜明的细节推进当前场景，不要空泛抒情，不要替玩家做决定。",
            "所有新信息都应与既有世界设定保持连续，尤其是地点、势力、技术或超自然规则。",
            `当前世界建议风格：${style["zh-CN"]}`
          ].join("\n"),
          en: [
            "Use a calm, concrete GM voice and prioritize details the player can directly observe.",
            "Advance the scene with 2 to 4 sharp details. Avoid vague filler and do not decide actions for the player.",
            "Keep every new detail consistent with established world facts, especially locations, factions, technology, and supernatural rules.",
            `Preferred tone for this world: ${style.en}`
          ].join("\n")
        }),
        priority: 100,
        channel: "instruction",
        pinned: true
      }
    ];
  }
};

export default contextProvider;

function inferNarrationStyle(worldName: string, worldDescription: string) {
  const text = `${worldName} ${worldDescription}`.toLowerCase();

  if (/江湖|武侠|门派|九州|wuxia|martial/.test(text)) {
    return {
      "zh-CN": "偏江湖传奇，强调门派、规矩、气势与人情债。",
      en: "Lean into martial-world drama with sect politics, codes of honor, pressure, and personal debts."
    } as const;
  }

  if (/赛博|义体|霓虹|cyber|neon|megacorp/.test(text)) {
    return {
      "zh-CN": "偏冷硬赛博，强调霓虹、噪点、企业压迫与身体技术改造。",
      en: "Lean into hard cyberpunk with neon glare, signal noise, corporate pressure, and body-tech modification."
    } as const;
  }

  if (/修仙|灵气|都市|cultivation|qi/.test(text)) {
    return {
      "zh-CN": "偏都市奇幻，强调现代日常与超常规则并存的反差。",
      en: "Lean into urban fantasy, contrasting ordinary modern life with resurfacing supernatural rules."
    } as const;
  }

  if (/港|雾|风暴|灯塔|pier|fog|harbor/.test(text)) {
    return {
      "zh-CN": "偏潮湿海港与工业迷雾，强调盐雾、机械、帮派和危险航道。",
      en: "Lean into a damp industrial harbor mood with salt fog, machinery, crews, and dangerous channels."
    } as const;
  }

  return {
    "zh-CN": "偏紧凑冒险叙事，强调场景张力、线索和下一步行动空间。",
    en: "Lean into compact adventure narration with scene tension, clues, and room for the next action."
  } as const;
}
