import type { ContextProviderInput } from "@covel/plugin-runtime";

/**
 * Build narrator persona context based on world data.
 */
export async function personaContextProvider(input: ContextProviderInput) {
  const world = input.world as { name?: string; description?: string } | undefined;
  const style = inferNarrationStyle(
    world?.name ?? "",
    world?.description ?? ""
  );

  const locale = input.locale;
  const isZh = locale.startsWith("zh");

  return {
    id: "narrator-persona",
    title: isZh ? "叙事人格" : "Narrator persona",
    content: isZh
      ? [
          "保持冷静、具体、可落地的主持人口吻，优先描写玩家可观察到的事实。",
          "用 2 到 4 个足够鲜明的细节推进当前场景，不要空泛抒情，不要替玩家做决定。",
          "所有新信息都应与既有世界设定保持连续，尤其是地点、势力、技术或超自然规则。",
          `当前世界建议风格：${style.zh}`,
        ].join("\n")
      : [
          "Use a calm, concrete GM voice and prioritize details the player can directly observe.",
          "Advance the scene with 2 to 4 sharp details. Avoid vague filler and do not decide actions for the player.",
          "Keep every new detail consistent with established world facts, especially locations, factions, technology, and supernatural rules.",
          `Preferred tone for this world: ${style.en}`,
        ].join("\n"),
    priority: 100,
  };
}

function inferNarrationStyle(
  worldName: string,
  worldDescription: string
): { zh: string; en: string } {
  const text = `${worldName} ${worldDescription}`.toLowerCase();

  if (/江湖|武侠|门派|九州|wuxia|martial/.test(text)) {
    return {
      zh: "偏江湖传奇，强调门派、规矩、气势与人情债。",
      en: "Lean into martial-world drama with sect politics, codes of honor, pressure, and personal debts.",
    };
  }

  if (/赛博|义体|霓虹|cyber|neon|megacorp/.test(text)) {
    return {
      zh: "偏冷硬赛博，强调霓虹、噪点、企业压迫与身体技术改造。",
      en: "Lean into hard cyberpunk with neon glare, signal noise, corporate pressure, and body-tech modification.",
    };
  }

  if (/修仙|灵气|都市|cultivation|qi/.test(text)) {
    return {
      zh: "偏都市奇幻，强调现代日常与超常规则并存的反差。",
      en: "Lean into urban fantasy, contrasting ordinary modern life with resurfacing supernatural rules.",
    };
  }

  if (/港|雾|风暴|灯塔|pier|fog|harbor/.test(text)) {
    return {
      zh: "偏潮湿海港与工业迷雾，强调盐雾、机械、帮派和危险航道。",
      en: "Lean into a damp industrial harbor mood with salt fog, machinery, crews, and dangerous channels.",
    };
  }

  return {
    zh: "偏紧凑冒险叙事，强调场景张力、线索和下一步行动空间。",
    en: "Lean into compact adventure narration with scene tension, clues, and room for the next action.",
  };
}
