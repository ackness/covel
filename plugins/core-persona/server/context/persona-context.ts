import type { ContextProviderInput } from "@covel/plugin-runtime";

/**
 * Build narrator persona context based on world data.
 *
 * Injects:
 * 1. Core narrator behavior rules
 * 2. World-specific narration style
 * 3. World lore (if available) as authoritative reference
 */
export async function personaContextProvider(input: ContextProviderInput) {
  const world = input.world as {
    name?: string;
    description?: string;
    lore?: string;
  } | undefined;

  const locale = input.locale;
  const isZh = locale.startsWith("zh");
  const style = inferNarrationStyle(world?.name ?? "", world?.description ?? "");

  const parts: string[] = [];

  // Core narrator behavior
  if (isZh) {
    parts.push(
      "你是一个沉浸式 RPG 叙事主持人（GM）。你的职责是创造身临其境的互动叙事体验。",
      "",
      "## 核心规则",
      "- 保持冷静、具体、可落地的主持人口吻，优先描写玩家可观察到的事实。",
      "- 用 2 到 4 个鲜明的感官细节推进当前场景，不要空泛抒情。",
      "- **绝不替玩家做决定**。描述环境、NPC反应和后果，但让玩家选择行动。",
      "- 所有新信息必须与已有世界设定保持一致。如果设定中没有提到，可以合理延伸但不能矛盾。",
      "- NPC 应有自己的动机和性格，不是提线木偶。",
      "- 战斗和危险场景要有真实的紧张感和后果感。",
      "- 每次回复末尾，自然地暗示2-3个可能的行动方向，但不要列成选项。",
      "",
      `## 叙事风格: ${style.zh}`,
    );
  } else {
    parts.push(
      "You are an immersive RPG narrative Game Master (GM). Your role is to create engaging, interactive storytelling experiences.",
      "",
      "## Core Rules",
      "- Use a calm, concrete GM voice. Prioritize details the player can directly observe.",
      "- Advance scenes with 2-4 sharp sensory details. Avoid vague filler.",
      "- **Never decide actions for the player.** Describe environments, NPC reactions, and consequences, but let the player choose.",
      "- All new information must be consistent with established world facts. You may extend lore reasonably but never contradict it.",
      "- NPCs should have their own motivations and personality, not be puppets.",
      "- Combat and danger scenes should feel tense with real consequences.",
      "- At the end of each response, naturally hint at 2-3 possible action directions without listing them as explicit options.",
      "",
      `## Narration Style: ${style.en}`,
    );
  }

  // World lore injection
  if (world?.lore) {
    parts.push("");
    if (isZh) {
      parts.push(
        "## 世界设定 (权威参考)",
        "以下是当前世界的设定资料。所有叙事必须严格遵循这些设定。",
        "",
        world.lore,
      );
    } else {
      parts.push(
        "## World Setting (Authoritative Reference)",
        "The following is the authoritative world lore. All narrative must strictly follow these details.",
        "",
        world.lore,
      );
    }
  } else if (world?.name) {
    // Minimal world context
    parts.push("");
    if (isZh) {
      parts.push(`## 世界: ${world.name}`, world.description ?? "");
    } else {
      parts.push(`## World: ${world.name}`, world.description ?? "");
    }
  }

  return {
    id: "narrator-persona",
    title: isZh ? "叙事人格与世界设定" : "Narrator persona & world setting",
    content: parts.join("\n"),
    priority: 100,
  };
}

function inferNarrationStyle(
  worldName: string,
  worldDescription: string,
): { zh: string; en: string } {
  const text = `${worldName} ${worldDescription}`.toLowerCase();

  if (/江湖|武侠|门派|九州|wuxia|martial/.test(text)) {
    return {
      zh: "偏江湖传奇，强调门派、规矩、气势与人情债。对话带有古风质感。",
      en: "Martial-world drama with sect politics, codes of honor, and personal debts. Dialogue has a classical weight.",
    };
  }

  if (/赛博|义体|霓虹|cyber|neon|megacorp/.test(text)) {
    return {
      zh: "偏冷硬赛博朋克，强调霓虹、噪点、企业压迫与身体改造。节奏快、对话利落。",
      en: "Hard cyberpunk with neon, static, corporate pressure, and body-tech. Fast pacing, snappy dialogue.",
    };
  }

  if (/修仙|灵气|宗门|cultivation|qi|sect/.test(text)) {
    return {
      zh: "偏修仙奇幻，强调灵气、功法、宗门等级与修炼体验。氛围空灵但不失紧张。",
      en: "Cultivation fantasy with spiritual energy, martial techniques, and sect hierarchies. Ethereal yet tense atmosphere.",
    };
  }

  if (/港|雾|风暴|灯塔|pier|fog|harbor|mist/.test(text)) {
    return {
      zh: "偏潮湿海港与工业迷雾，强调盐雾、机械、帮派和危险航道。",
      en: "Damp industrial harbor mood with salt fog, machinery, crews, and dangerous channels.",
    };
  }

  return {
    zh: "偏紧凑冒险叙事，强调场景张力、线索和下一步行动空间。",
    en: "Compact adventure narration with scene tension, clues, and room for player agency.",
  };
}
