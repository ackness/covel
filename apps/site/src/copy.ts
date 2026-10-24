// Every string the site shows, once per language. `Copy` is the English
// shape; the Chinese table must match it key for key, so a missing line is a
// type error rather than a blank on the page.

export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

interface WorldCopy {
  id: string;
  name: string;
  genre: string;
  summary: string;
}

export interface Item {
  title: string;
  body: string;
}

/** The ways to play the hero cycles through. */
export type Visual = "stage" | "tabletop" | "story" | "languages";

interface Mode {
  visual: Visual;
  word: string;
  body: string;
  /** Describes the screenshot; empty for a scene with no picture. */
  alt: string;
}

interface CorePlugin {
  icon: string;
  ids: string;
  title: string;
  body: string;
}

/** The bundled plugins the hero lights up, in display order. */
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

const en = {
  meta: {
    /** Where this language's edition starts under the documentation site. */
    docsPath: "en/",
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
    tagline: "Everything is pluggable. Every world is yours.",
    lead: "Build your own",
    modes: [
      {
        visual: "stage",
        word: "visual novel.",
        body: "Character sprites over scene backdrops, typewriter dialogue and replies to pick, with several characters sharing the stage.",
        alt: "Stage mode in Covel",
      },
      {
        visual: "tabletop",
        word: "tabletop campaign.",
        body: "Point-buy at the start, dice checks with a receipt for every roll, quests and inventory. Play freely; the rules make the call.",
        alt: "Quests, inventory and affinity in a tabletop session",
      },
      {
        visual: "story",
        word: "epic story.",
        body: "The story branches on your choices, suggested actions keep it moving, and the world's state follows every turn.",
        alt: "Story mode in Covel",
      },
      {
        visual: "languages",
        word: "multilingual world.",
        body: "An interface in Chinese, English and Russian, worlds with several language editions, and agents that write in the language of the session.",
        alt: "",
      },
    ] satisfies Mode[],
    modesLabel: "Ways to play",
    languages: ["简体中文", "English", "Русский"],
    primary: "Download",
    primaryFor: {
      mac: "Download for macOS",
      windows: "Windows installer (recommended)",
    },
    otherPlatforms: "Other systems and checksums",
    zip: "ZIP · extract once, no install",
    zipHelp:
      "For ZIP, choose Extract All, then open Covel.exe in the extracted folder.",
    portable: "Self-extracting EXE · no install",
    portableHelp: "The single-file EXE prepares the app on every launch.",
    openHelp: {
      mac: {
        summary: "macOS says the app is damaged?",
        body: "The app is not damaged. The build is not signed or notarized, so macOS blocks an app that a browser downloaded. Click Cancel, move Covel to Applications, then run this in Terminal and open the app again:",
      },
      windows: {
        summary: "Windows protected your PC?",
        body: "The installer is not signed, so Microsoft Defender SmartScreen stops it the first time. Click “More info”, then “Run anyway”. If the browser holds the download back, choose “Keep” in its download list first.",
      },
    },
    secondary: "View source",
    note: "macOS (Apple silicon) and Windows x64 · MIT licensed",
  },
  pillars: {
    eyebrow: "Under the hood",
    title: "Plugins run the game. You define the world.",
    plugin: {
      title: "Plugin-driven to the core",
      points: [
        {
          title: "Decoupled, plug and play",
          body: "Tools, actions, memory and interface panels are all plugins. Switch any of them on or off per session.",
        },
        {
          title: "Extend without touching the core",
          body: "Write or install a plugin to give the agents new abilities and rules, with no change to the kernel.",
        },
      ] satisfies Item[],
    },
    world: {
      title: "Worlds and rules, fully yours",
      points: [
        {
          title: "Complete world packs",
          body: "Setting, characters, factions, stats, starting items and quests travel in one open package you can read and change.",
        },
        {
          title: "Persistent state, sandbox play",
          body: "From a light conversation to a sandbox with exact rules, the engine runs the world the way you set it up.",
        },
      ],
    },
    worldAlt: "The world-building agent in Covel",
    links: [
      { label: "Plugin guide", href: "docs/plugins/essentials.md" },
      { label: "Packaging worlds", href: "docs/ship/collections.md" },
    ],
  },
  rack: {
    label: "Plugins on",
    packs: {
      stage: "Harukaze Academy · visual novel",
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
        name: "Mistport: The Riftide Chronicle",
        genre: "Dark fantasy · Investigation",
        summary:
          "The tide bell strikes three times. A missing Guildmaster and a shattered Key pull you into a four-way shadow war in a harbor city lost in endless fog.",
      },
      {
        id: "haruka-academy",
        name: "Harukaze Academy · Spring Mint",
        genre: "Campus · Visual novel",
        summary:
          "Transfer to a private high school by the sea. With twenty-one days until the school festival, choose a club, keep your promises, and answer the feelings left unspoken.",
      },
      {
        id: "lantern-barrow",
        name: "Lantern Barrow: The First Delve",
        genre: "Fantasy · Tabletop",
        summary:
          "After a century, the lantern has gone out and the bronze doors stand open. Form a party, spend your points, and roll your way down.",
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
    docsPath: "",
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
    tagline: "一切皆可插拔，每个世界都属于你。",
    lead: "构建由你定义的",
    modes: [
      {
        visual: "stage",
        word: "视觉小说舞台",
        body: "角色立绘叠在场景背景上，打字机式对白和可选回复，多名角色同台登场。",
        alt: "Covel 的舞台模式",
      },
      {
        visual: "tabletop",
        word: "跑团冒险",
        body: "开局配点、掷骰检定，每次判定都有回执，任务与行囊一应俱全。扮演自由，判定照规则来。",
        alt: "跑团会话里的任务、行囊与好感",
      },
      {
        visual: "story",
        word: "长篇故事",
        body: "剧情随你的选择分支，行动建议帮你接上下一步，世界状态逐回合推进。",
        alt: "Covel 的故事模式",
      },
      {
        visual: "languages",
        word: "多语言世界",
        body: "界面支持中、英、俄三种语言，世界可以带多个语言版本，智能体按会话语言写作。",
        alt: "",
      },
    ],
    modesLabel: "玩法",
    languages: ["简体中文", "English", "Русский"],
    primary: "下载",
    primaryFor: { mac: "下载 macOS 版", windows: "Windows 安装版（推荐）" },
    otherPlatforms: "其他系统和校验文件",
    zip: "ZIP 版 · 解压一次，免安装",
    zipHelp: "ZIP 版请先选择“全部解压缩”，再打开解压文件夹中的 Covel.exe。",
    portable: "自解压 EXE · 免安装",
    portableHelp: "单文件 EXE 每次启动都会重新准备应用。",
    openHelp: {
      mac: {
        summary: "macOS 提示“已损坏，无法打开”？",
        body: "应用没有损坏。安装包没有签名和公证，macOS 会拦截浏览器下载的应用。点“取消”，把 Covel 拖进“应用程序”，在终端运行下面这行，再重新打开：",
      },
      windows: {
        summary: "Windows 提示“已保护你的电脑”？",
        body: "安装包没有签名，Microsoft Defender SmartScreen 第一次运行时会拦截。点“更多信息”，再点“仍要运行”。如果浏览器拦下了下载，先在下载列表里选择“保留”。",
      },
    },
    secondary: "查看源码",
    note: "macOS（Apple 芯片）和 Windows x64 · MIT 许可",
  },
  pillars: {
    eyebrow: "底层设计",
    title: "插件驱动玩法，世界由你定义。",
    plugin: {
      title: "彻底的插件驱动设计",
      points: [
        {
          title: "解耦与即插即用",
          body: "工具、动作、记忆和交互面板全是插件，每个会话都能单独开关。",
        },
        {
          title: "零侵入扩展",
          body: "不改内核，开发或安装一个插件，就能给智能体加上新能力和新规则。",
        },
      ],
    },
    world: {
      title: "深度世界观与规则自定义",
      points: [
        {
          title: "全要素世界包",
          body: "世界观、角色、阵营、数值、初始道具和任务装在一个公开的包里，随时可读可改。",
        },
        {
          title: "状态持久与沙盒运转",
          body: "从轻度的对话空间到规则精密的沙盒，引擎都按你的设定运转世界。",
        },
      ],
    },
    worldAlt: "Covel 的世界构筑 Agent",
    links: [
      { label: "插件开发指南", href: "docs/plugins/essentials.md" },
      { label: "世界打包指南", href: "docs/ship/collections.md" },
    ],
  },
  rack: {
    label: "已启用插件",
    packs: {
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
        name: "余烬岭中继站",
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
