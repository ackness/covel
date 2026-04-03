import { resolve } from "node:path";
import type { ContextProviderInput } from "@covel/plugin-runtime";
import { loadPrompt } from "@covel/context";

const PROMPTS_DIR = resolve(import.meta.dirname, "../../prompts");

/**
 * Build narrator persona context based on world data.
 *
 * Injects:
 * 1. Core narrator behavior rules (loaded from prompts/)
 * 2. World-specific narration style
 * 3. World lore (if available) as authoritative reference
 */
export async function personaContextProvider(input: ContextProviderInput): Promise<{
  id: string;
  title: string;
  content: string;
  priority: number;
}> {
  const world = input.world as {
    name?: string;
    description?: string;
    lore?: string;
  } | undefined;

  const locale = input.locale;
  const isZh = locale.startsWith("zh");
  const style = inferNarrationStyle(world?.name ?? "", world?.description ?? "");

  const parts: string[] = [];

  // Core narrator behavior (loaded from markdown)
  const rules = await loadPrompt(PROMPTS_DIR, "persona-rules", locale);
  parts.push(rules);
  parts.push("");
  parts.push(isZh ? `## 叙事风格: ${style.zh}` : `## Narration Style: ${style.en}`);

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
