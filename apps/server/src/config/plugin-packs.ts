import type { PluginPack } from "@covel/shared";

/** Curated product presets. They are data, not framework control flow. */
export const BUILTIN_PLUGIN_PACKS: readonly PluginPack[] = [
  {
    id: "traditional-story",
    label: {
      "zh-CN": "传统故事模式",
      "en-US": "Traditional Story",
      "ru-RU": "Традиционная история",
    },
    description: {
      "zh-CN": "主叙事器、行动建议、图鉴和关系图，适合长篇探索。",
      "en-US":
        "Narrator, suggestions, codex, and relationship memory for long-form exploration.",
      "ru-RU":
        "Рассказчик, предложения, кодекс и память взаимоотношений для подробного исследования.",
    },
    pluginIds: [
      "pregame",
      "world-init",
      "char-creator",
      "narrator",
      "guide",
      "codex",
      "npc-graph",
      "living-world-rules",
    ],
    optionalPluginIds: ["memory"],
    excludedPluginIds: [
      "chat-mode-narrator",
      "scene-cast",
      "scene-stage",
      "scene-prompts",
      "branch-reply",
    ],
    tags: ["mode:traditional-story"],
    source: "builtin",
  },
  {
    id: "dialogue-mode",
    label: {
      "zh-CN": "对话模式",
      "en-US": "Dialogue Mode",
      "ru-RU": "Диалоговый режим",
    },
    description: {
      "zh-CN": "对话优先叙事、场景演员、快速短句和角色资料。",
      "en-US":
        "Dialogue-first narration, scene cast state, quick replies, and character profiles.",
      "ru-RU":
        "Повествование через диалоги, состав текущей сцены, быстрые ответы и профили персонажей.",
    },
    pluginIds: [
      "pregame",
      "world-init",
      "char-creator",
      "chat-mode-narrator",
      "scene-cast",
      "scene-stage",
      "scene-prompts",
      "character-blueprint",
      "character-presence",
      "living-world-rules",
      "branch-reply",
    ],
    optionalPluginIds: ["memory", "npc-graph"],
    excludedPluginIds: ["narrator", "guide", "codex"],
    tags: ["mode:dialogue"],
    source: "builtin",
  },
  {
    id: "low-cost",
    label: {
      "zh-CN": "低成本",
      "en-US": "Low Cost",
      "ru-RU": "Бюджетный",
    },
    description: {
      "zh-CN":
        "保留核心流程和函数型插件，减少下游 LLM 调用；cost-gate 为每局设置 token 花费上限。",
      "en-US":
        "Keeps the core loop and function plugins while reducing downstream LLM calls; cost-gate caps per-session token spend.",
      "ru-RU":
        "Сохраняет основной цикл и функциональные плагины, сокращая последующие вызовы LLM; модуль контроля затрат ограничивает расход токенов на сессию.",
    },
    pluginIds: [
      "pregame",
      "world-init",
      "char-creator",
      "narrator",
      "living-world-rules",
      "cost-gate",
    ],
    optionalPluginIds: ["memory"],
    excludedPluginIds: ["guide", "codex", "scene-prompts"],
    tags: ["cost:function"],
    source: "builtin",
  },
];
