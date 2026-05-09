import type { I18nText } from "@covel/shared";

/** Minimal seed worlds for first-time local mode users. */
export const LOCAL_SEED_WORLDS: Array<{
  name: I18nText;
  description: I18nText;
  tags: string[];
}> = [
  {
    name: { "zh-CN": "雾港・裂潮纪", "en-US": "Mistport Chronicles" },
    description: {
      "zh-CN": "一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。",
      "en-US":
        "A port city shrouded in eternal fog. The tides bring ancient relics—and danger.",
    },
    tags: ["dark-fantasy", "mystery", "exploration"],
  },
  {
    name: { "zh-CN": "霓虹脊・2087", "en-US": "Neon Ridge 2087" },
    description: {
      "zh-CN": "赛博朋克都市，义体改造与数据黑市交织的霓虹丛林。",
      "en-US":
        "A cyberpunk metropolis where body augmentation and data black markets intertwine beneath neon lights.",
    },
    tags: ["cyberpunk", "augmentation", "hacker"],
  },
  {
    name: { "zh-CN": "九州・云梦泽", "en-US": "Nine Realms: Cloud Marsh" },
    description: {
      "zh-CN": "修仙世界，灵脉纵横，宗门林立，一场席卷九州的劫变正在酝酿。",
      "en-US":
        "A cultivation world of spirit veins, rival sects, and a looming tribulation that threatens all Nine Realms.",
    },
    tags: ["xianxia", "cultivation", "sects"],
  },
];
