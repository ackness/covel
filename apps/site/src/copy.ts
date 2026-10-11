// Every string the site shows, once per language. `Copy` is the English
// shape; the Chinese table must match it key for key, so a missing line is a
// type error rather than a blank on the page.

export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export interface WorldCopy {
  id: string;
  name: string;
  genre: string;
  summary: string;
}

export interface Item {
  title: string;
  body: string;
}

/** What the sticky panel beside a step of the feature matrix shows. */
export type Visual =
  "plugin" | "world" | "stage" | "tabletop" | "story" | "languages";

export interface CorePlugin {
  icon: string;
  ids: string;
  title: string;
  body: string;
}

/** The bundled plugins the matrix panel lights up, in display order. */
export const PLUGIN_IDS = [
  "narrator",
  "chat-mode-narrator",
  "scene-stage",
  "character-blueprint",
  "branch-reply",
  "tabletop-rules",
  "dice-check",
  "core-quest",
  "inventory",
  "affinity",
  "npc-graph",
  "codex",
  "story-events",
  "guide",
  "living-world-rules",
  "memory",
  "world-time",
  "soundtrack",
] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];

export interface Chapter {
  title: string;
  steps: { visual: Visual; points: Item[] }[];
}

const en = {
  meta: {
    title: "Covel · Everything is pluggable, every world is yours",
    description:
      "Covel is a plugin-driven, open-source interactive framework for multi-agent storytelling: stage, TRPG and story modes, multilingual, with every plugin and world customisable.",
  },
  nav: {
    features: "Features",
    plugins: "Plugins",
    worlds: "Worlds",
    docs: "Docs",
    download: "Download",
    language: "中文",
    languageLabel: "切换到中文",
    menu: "Menu",
    toLight: "Use the light theme",
    toDark: "Use the dark theme",
  },
  hero: {
    badge: "Open source · Early access",
    titleA: "Everything is pluggable.",
    titleB: "Every world is yours.",
    body: "Plugin-driven · Custom rules · An open-source interactive framework built for multi-agent storytelling and play.",
    primary: "Download",
    primaryFor: { mac: "Download for macOS", windows: "Download for Windows" },
    otherPlatforms: "Other systems and checksums",
    portable: "Portable version, no install",
    secondary: "View source",
    note: "macOS (Apple silicon) and Windows x64 · MIT licensed",
    videoLabel: "A Covel session being played",
  },
  matrix: {
    eyebrow: "Core features",
    title: "From plugins to worlds, everything is yours to define.",
    chapters: [
      {
        title: "Plugin-driven to the core",
        steps: [
          {
            visual: "plugin",
            points: [
              {
                title: "Decoupled, plug and play",
                body: "From tool calls and low-level actions to memory and interface panels, every component in the chain can be plugged in or swapped out.",
              },
              {
                title: "Extend without touching the core",
                body: "Write or install a plugin to give agents new capabilities and logic, with no changes to the kernel.",
              },
            ],
          },
        ],
      },
      {
        title: "Worlds and rules, fully customisable",
        steps: [
          {
            visual: "world",
            points: [
              {
                title: "Complete world packs",
                body: "Build the setting, characters, faction rules and stat systems. Every part of a world is open, readable and yours to change.",
              },
              {
                title: "Persistent state, sandbox play",
                body: "From a light conversational space to a sandbox with precise rules, the engine runs the world exactly as you set it up.",
              },
            ],
          },
        ],
      },
      {
        title: "Ways to play, out of the box",
        steps: [
          {
            visual: "stage",
            points: [
              {
                title: "Stage mode",
                body: "A full-screen visual novel: character sprites over scene backdrops, typewriter dialogue and choices to pick from, with several characters sharing the stage.",
              },
            ],
          },
          {
            visual: "tabletop",
            points: [
              {
                title: "TRPG mode",
                body: "Built for tabletop role-play: point-buy characters, dice checks with visible receipts, quests and inventory. Free-form role-play, with rulings that follow the rules.",
              },
            ],
          },
          {
            visual: "story",
            points: [
              {
                title: "Story mode",
                body: "Classic interactive fiction for long-form play: the story branches on your choices, suggested actions keep you moving, and the world's state follows every turn.",
              },
            ],
          },
        ],
      },
      {
        title: "Multilingual throughout",
        steps: [
          {
            visual: "languages",
            points: [
              {
                title: "Create across languages",
                body: "The interface comes in Chinese, English and Russian. Worlds can ship several language editions, agents write in the language of the session, and plugin prompts come in English and Chinese.",
              },
            ],
          },
        ],
      },
    ] satisfies Chapter[],
    languages: ["简体中文", "English", "Русский"],
    codeLabel: "plugins/observation/PLUGIN.md",
    imageAlt: {
      world: "The world-building agent in Covel",
      stage: "Stage mode in Covel",
      tabletop: "Quests, inventory and affinity in a tabletop session",
      story: "Story mode in Covel",
    },
    links: [
      { label: "Plugin guide", href: "docs/guide/plugin-authoring.md" },
      { label: "Packaging worlds", href: "docs/guide/collections.md" },
    ],
  },
  rack: {
    label: "Plugins on",
    packs: {
      plugin: "Every bundled plugin",
      world: "Emberback Relay's own set",
      stage: "Haruka Academy · visual novel",
      tabletop: "Lantern Barrow · classic tabletop",
      story: "Traditional story",
      languages: "Every bundled plugin",
    } satisfies Record<Visual, string>,
    names: {
      narrator: "Narrator",
      "chat-mode-narrator": "Dialogue narrator",
      "scene-stage": "Scene stage",
      "character-blueprint": "Character profiles",
      "branch-reply": "Reply variants",
      "tabletop-rules": "Tabletop rules",
      "dice-check": "Dice checks",
      "core-quest": "Quest log",
      inventory: "Inventory",
      affinity: "Affinity",
      "npc-graph": "Relationships",
      codex: "Codex",
      "story-events": "Hidden events",
      guide: "Action suggestions",
      "living-world-rules": "World rules",
      memory: "Story memory",
      "world-time": "World time",
      soundtrack: "Soundtrack",
    } satisfies Record<PluginId, string>,
  },
  core: {
    eyebrow: "Built-in plugins",
    title: "A full RPG kit, every piece replaceable.",
    body: "Covel's kernel hard-codes no gameplay. Even the built-in features ship as ordinary plugins, so you can extend them, override them, or swap them out entirely.",
    items: [
      {
        icon: "🎲",
        ids: "tabletop-rules · dice-check",
        title: "Rules and dice checks",
        body: "Point-buy at the start, attribute checks against dice pools, and a receipt for every roll. The engine rolls the dice and the rules decide, not the model's guess.",
      },
      {
        icon: "🎒",
        ids: "inventory",
        title: "Inventory",
        body: "Records every item gained, lost or equipped in the story, with a bag panel always one click away. Worlds can set the starting gear.",
      },
      {
        icon: "📜",
        ids: "core-quest",
        title: "Quest log",
        body: "Registers and advances quests straight from the narrative, so goals, progress and rewards stay in view.",
      },
      {
        icon: "❤️",
        ids: "affinity · npc-graph",
        title: "Affinity and relationships",
        body: "Scores and tiers for how each character feels about you, plus a graph of who knows whom, so people stay consistent when they come back.",
      },
      {
        icon: "📚",
        ids: "codex",
        title: "Codex",
        body: "Collects the places, people, items and rumours you discover, and fills in as you explore.",
      },
      {
        icon: "🕯️",
        ids: "story-events",
        title: "Hidden events",
        body: "Events the world's author hides stay out of the prompt and out of sight until their conditions are met, then hand the narrator its cue.",
      },
      {
        icon: "🎙️",
        ids: "narrator",
        title: "Narrator",
        body: "First, second or third person, your choice, with the story streamed as it is written.",
      },
      {
        icon: "🎵",
        ids: "soundtrack",
        title: "Soundtrack",
        body: "Plays the music a world ships and follows the scene and the mood of the story.",
      },
    ] satisfies CorePlugin[],
  },
  worlds: {
    eyebrow: "Built-in worlds",
    title: "Four worlds, ready to explore.",
    body: "All original, with character portraits and scene art, and each comes with the set of plugins that suits it best.",
    list: [
      {
        id: "mistport",
        name: "Mistport Chronicles",
        genre: "Dark fantasy · Investigation",
        summary:
          "Three tide-bells, a missing Guildmaster and a shattered Key draw you into a four-way struggle beneath Mistport's eternal fog.",
      },
      {
        id: "haruka-academy",
        name: "Haruka Academy · Spring Mint",
        genre: "Campus · Visual novel",
        summary:
          "Transfer to a seaside high school, choose a club, keep your promises, and answer unspoken feelings during a twenty-one-day festival countdown.",
      },
      {
        id: "lantern-barrow",
        name: "Lantern Barrow: First Expedition",
        genre: "Fantasy · Tabletop",
        summary:
          "The barrow's lantern has gone out and its bronze doors stand open. Form a party, spend your points and roll your way down.",
      },
      {
        id: "emberback",
        name: "Emberback Relay",
        genre: "Science fiction · Survival",
        summary:
          "A lonely relay on a tidally locked world receives a distress call in your own voice, sent from seventy-two hours in the future.",
      },
    ] satisfies WorldCopy[],
  },
  cta: {
    title: "Your story starts here.",
    body: "Download Covel, connect a model, and choose a world.",
  },
  footer: {
    license: "MIT licensed · Covel contributors",
    docs: "Docs",
    changelog: "Changelog",
    source: "Source",
  },
};

export type Copy = typeof en;

const zh: Copy = {
  meta: {
    title: "Covel · 一切皆可插拔，每个世界都属于你",
    description:
      "Covel 是插件驱动的开源交互框架，专为多智能体叙事与演练打造：舞台、跑团与故事模式，全链路多语言，所有插件与世界皆可自定义。",
  },
  nav: {
    features: "特性",
    plugins: "插件",
    worlds: "世界",
    docs: "文档",
    download: "下载",
    language: "EN",
    languageLabel: "Switch to English",
    menu: "菜单",
    toLight: "切换到浅色主题",
    toDark: "切换到深色主题",
  },
  hero: {
    badge: "开源 · 抢先体验",
    titleA: "一切皆可插拔，",
    titleB: "每个世界都属于你。",
    body: "插件驱动 · 规则自定义 · 专为多智能体叙事与演练打造的开源交互框架。",
    primary: "下载",
    primaryFor: { mac: "下载 macOS 版", windows: "下载 Windows 版" },
    otherPlatforms: "其他系统和校验文件",
    portable: "便携版（免安装）",
    secondary: "查看源码",
    note: "macOS（Apple 芯片）和 Windows x64 · MIT 许可",
    videoLabel: "一局 Covel 会话的录屏",
  },
  matrix: {
    eyebrow: "核心特性",
    title: "从插件到世界，一切由你定义。",
    chapters: [
      {
        title: "彻底的插件驱动设计",
        steps: [
          {
            visual: "plugin",
            points: [
              {
                title: "解耦与即插即用",
                body: "从工具调用、底层动作、记忆机制到交互面板，全链路组件皆为可插拔设计。",
              },
              {
                title: "零侵入扩展",
                body: "无需改动内核，即可通过开发或引入新插件，为智能体扩展任意外部能力与业务逻辑。",
              },
            ],
          },
        ],
      },
      {
        title: "深度世界观与规则自定义",
        steps: [
          {
            visual: "world",
            points: [
              {
                title: "全要素世界包",
                body: "自由构建世界观背景、角色、阵营法则与数值体系，所有世界设定公开透明，支持按需定制。",
              },
              {
                title: "状态持久与沙盒运转",
                body: "无论是轻度的对话空间，还是规则精密的独立沙盒，世界引擎都会严格按你的设定平稳运转。",
              },
            ],
          },
        ],
      },
      {
        title: "丰富的开箱即用玩法",
        steps: [
          {
            visual: "stage",
            points: [
              {
                title: "舞台模式（Stage Mode）",
                body: "全屏视觉小说体验：角色立绘叠在场景背景上，打字机式对白和可选的回复，多名角色同台登场。",
              },
            ],
          },
          {
            visual: "tabletop",
            points: [
              {
                title: "跑团生态（TRPG Mode）",
                body: "专为桌面角色扮演设计：开局配点、掷骰检定和可回看的判定回执，任务与行囊一应俱全。扮演自由，判定照规则来。",
              },
            ],
          },
          {
            visual: "story",
            points: [
              {
                title: "故事模式（Story Mode）",
                body: "经典互动小说：剧情随你的选择分支，行动建议帮你接上下一步，世界状态逐回合推进，适合长篇共创。",
              },
            ],
          },
        ],
      },
      {
        title: "全链路多语言支持",
        steps: [
          {
            visual: "languages",
            points: [
              {
                title: "跨语言自由创作",
                body: "界面支持简体中文、英文与俄文；世界可以提供多个语言版本，智能体按会话语言输出，插件提示词提供中英两版。",
              },
            ],
          },
        ],
      },
    ],
    languages: ["简体中文", "English", "Русский"],
    codeLabel: "plugins/observation/PLUGIN.md",
    imageAlt: {
      world: "Covel 的世界构筑 Agent",
      stage: "Covel 的舞台模式",
      tabletop: "跑团会话里的任务、行囊与好感",
      story: "Covel 的故事模式",
    },
    links: [
      { label: "插件开发指南", href: "docs/guide/plugin-authoring.md" },
      { label: "世界打包指南", href: "docs/guide/collections.md" },
    ],
  },
  rack: {
    label: "已启用插件",
    packs: {
      plugin: "全部内置插件",
      world: "余烬背中继站 · 世界预设",
      stage: "遥风学园 · 视觉小说",
      tabletop: "提灯古冢 · 经典跑团",
      story: "传统故事模式",
      languages: "全部内置插件",
    },
    names: {
      narrator: "叙事",
      "chat-mode-narrator": "对话叙事",
      "scene-stage": "场景舞台",
      "character-blueprint": "角色资料",
      "branch-reply": "回复变体",
      "tabletop-rules": "跑团规则",
      "dice-check": "骰子判定",
      "core-quest": "任务日志",
      inventory: "行囊",
      affinity: "好感度",
      "npc-graph": "关系图谱",
      codex: "设定图鉴",
      "story-events": "隐藏事件",
      guide: "行动建议",
      "living-world-rules": "世界规则",
      memory: "故事记忆",
      "world-time": "世界时间",
      soundtrack: "配乐",
    },
  },
  core: {
    eyebrow: "内置核心插件",
    title: "整套 RPG 机制开箱即用，每一件都能换。",
    body: "Covel 的内核不硬编码任何玩法。连内置能力也以标准插件提供，你可以扩展、覆盖，或者整个替换掉。",
    items: [
      {
        icon: "🎲",
        ids: "tabletop-rules · dice-check",
        title: "规则与骰点检定",
        body: "开局点数购制、按骰池结算的属性检定，每次掷骰都留有回执。骰子由引擎来掷，结果按规则判定，不靠模型临场发挥。",
      },
      {
        icon: "🎒",
        ids: "inventory",
        title: "行囊与道具",
        body: "记下剧情里每一次获得、失去和换装，背包面板随时可查。世界包可以预设初始装备。",
      },
      {
        icon: "📜",
        ids: "core-quest",
        title: "任务日志",
        body: "从叙事中自动登记并推进任务，目标、进度和奖励一目了然。",
      },
      {
        icon: "❤️",
        ids: "affinity · npc-graph",
        title: "好感与关系链",
        body: "记录每个角色对你的好感分值、等级和近期变化，再用关系图谱记住谁认识谁，角色再次登场时前后一致。",
      },
      {
        icon: "📚",
        ids: "codex",
        title: "设定图鉴",
        body: "自动收录你发现的地点、人物、物品与传闻，随探索一点点展开。",
      },
      {
        icon: "🕯️",
        ids: "story-events",
        title: "隐藏事件",
        body: "世界作者埋下的暗线在条件满足前不进提示词、也不出现在玩家眼前；条件达成的那一回合，交给叙事接手。",
      },
      {
        icon: "🎙️",
        ids: "narrator",
        title: "叙事引擎",
        body: "第一、第二、第三人称随你选，正文边写边流式呈现。",
      },
      {
        icon: "🎵",
        ids: "soundtrack",
        title: "配乐",
        body: "播放世界自带的背景音乐，跟着场景和故事情绪切换。",
      },
    ],
  },
  worlds: {
    eyebrow: "内置世界",
    title: "四个世界，即刻启程。",
    body: "全部原创，配有角色立绘与场景插画，每个世界都预设了最适合它的插件组合。",
    list: [
      {
        id: "mistport",
        name: "雾港・裂潮纪",
        genre: "暗黑奇幻 · 推理",
        summary:
          "潮钟三鸣，失踪的公会长与一把破碎的钥匙，把你卷入永雾港城的四方暗战。",
      },
      {
        id: "haruka-academy",
        name: "遥风学园・春日薄荷",
        genre: "校园 · 视觉小说",
        summary:
          "转入海边私立高中，在二十一天的学园祭倒计时里选择社团、守住约定，也回应那些没能说出口的喜欢。",
      },
      {
        id: "lantern-barrow",
        name: "提灯古冢・初次远征",
        genre: "奇幻 · 跑团",
        summary:
          "守了百年的古冢之灯熄灭，青铜墓门洞开。组队、分配点数、掷骰下墓，从第一次远征开始。",
      },
      {
        id: "emberback",
        name: "余烬背中继站",
        genre: "科幻 · 生存",
        summary:
          "潮汐锁定世界上的孤立中继站，收到一封来自七十二小时后的求救信号，声音是你自己的。",
      },
    ],
  },
  cta: {
    title: "你的故事，从这里开始。",
    body: "下载 Covel，接入模型，选择一个世界。",
  },
  footer: {
    license: "MIT 许可 · Covel 贡献者",
    docs: "文档",
    changelog: "更新日志",
    source: "源码",
  },
};

export const COPY: Record<Lang, Copy> = { en, zh };

const STORAGE_KEY = "covel-site:lang";

function isLang(value: unknown): value is Lang {
  return (LANGS as readonly unknown[]).includes(value);
}

/** `?lang=` wins, then the visitor's earlier choice, then the browser. */
export function initialLang(): Lang {
  if (typeof window === "undefined") return "en";
  const fromQuery = new URLSearchParams(window.location.search).get("lang");
  if (isLang(fromQuery)) return fromQuery;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // Storage can be blocked; fall through to the browser language.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      if (new Intl.Locale(tag).language === "zh") return "zh";
      if (new Intl.Locale(tag).language === "en") return "en";
    } catch {
      // An invalid tag says nothing; try the next one.
    }
  }
  return "en";
}

export function rememberLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not remembered; the page still switches.
  }
}
