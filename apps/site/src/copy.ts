import { journeyEn, journeyZh } from "./journey-copy.js";
import { workbenchEn, workbenchZh } from "./workbench-copy.js";
import {
  extensionsEn,
  extensionsZh,
  foundationsEn,
  foundationsZh,
  creationEn,
  creationZh,
  ecosystemEn,
  ecosystemZh,
} from "./authoring-copy.js";
import { previewEn, previewZh } from "./preview-copy.js";

// Every string the site shows, once per language. `Copy` is the English
// shape; the Chinese table must match it key for key, so a missing line is a
// type error rather than a blank on the page.

export const LANGUAGES = {
  en: { label: "English", tag: "en", match: "en" },
  zh: { label: "简体中文", tag: "zh-CN", match: "zh" },
} as const;
export type Lang = keyof typeof LANGUAGES;
export const LANGS = Object.keys(LANGUAGES) as Lang[];

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
export type Visual = "stage" | "tabletop" | "story" | "survival";

interface Mode {
  visual: Visual;
  word: string;
  body: string;
  /** Describes the preview scene. */
  alt: string;
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
  "world-init",
  "soundtrack",
] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];

const en = {
  preview: previewEn,
  journey: journeyEn,
  workbench: workbenchEn,
  creation: creationEn,
  extensions: extensionsEn,
  ecosystem: ecosystemEn,
  meta: {
    /** Where this language's edition starts under the documentation site. */
    docsPath: "en/",
    title: "Covel · Everything is pluggable, every world is yours",
    description:
      "Covel is a plugin-driven, open-source interactive framework for multi-agent storytelling: stage, TRPG and story modes, multilingual, with every plugin and world customisable.",
  },
  nav: {
    features: "Foundations",
    plugins: "Try plugins",
    create: "Create",
    worlds: "Worlds",
    docs: "Docs",
    download: "Download",
    languageLabel: "Language",
    menu: "Menu",
    quick: "Quick navigation",
    toLight: "Use the light theme",
    toDark: "Use the dark theme",
  },
  hero: {
    badge: "Open source · Early access",
    tagline: "Plugins shape the play. World packs hold the story.",
    lead: "Write your own",
    modes: [
      {
        visual: "stage",
        word: "visual novel.",
        body: "A sea breeze stirs the pages. Familiar faces step into view. Meet them in dialogue, and choose the reply that opens the next chapter.",
        alt: "Stage mode in Covel",
      },
      {
        visual: "tabletop",
        word: "tabletop campaign.",
        body: "Raise a lantern at the barrow door. Build your character, pack your gear, and let the dice settle what courage alone cannot. Every roll leaves a record.",
        alt: "Quests, inventory and affinity in a tabletop session",
      },
      {
        visual: "story",
        word: "interactive fiction.",
        body: "A letter changes hands. A promise comes due. Follow a thread, take a different path, and watch your choices become part of the world's history.",
        alt: "Story mode in Covel",
      },
      {
        visual: "survival",
        word: "survival sandbox.",
        body: "A storm is three hours away. The clinic, the convoy and the radio all need power. Choose what to protect, and live with the world your choices leave behind.",
        alt: "Power, storm and rescue decisions at Emberback Relay",
      },
    ] satisfies Mode[],
    modesLabel: "Ways to play",
    primary: "Download",
    primaryFor: {
      mac: "Download for macOS",
      windows: "Windows installer (recommended)",
    },
    otherPlatforms: "All downloads",
    pause: "Pause preview",
    play: "Play preview",
    zip: "ZIP · extract once, no install",
    zipHelp:
      "No installation needed. Extract All once, then run Covel.exe from that folder. Keep its companion files; future launches skip extraction.",
    portable: "Self-extracting EXE · no install",
    portableHelp:
      "The single-file portable build extracts itself on every launch, which can mean a wait. Choose ZIP to avoid repeated extraction.",
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
  pillars: foundationsEn,
  rack: {
    label: "World plugins · selected view",
    packs: {
      stage: "Harukaze Academy · visual novel",
      tabletop: "Lantern Barrow · classic tabletop",
      story: "Traditional story",
      survival: "Emberback Relay · survival sandbox",
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
      "world-init": "World dimensions",
      soundtrack: "Soundtrack",
    } satisfies Record<PluginId, string>,
  },
  worlds: {
    eyebrow: "Built-in worlds",
    title: "Four worlds. Four first pages.",
    body: "A harbour in fog, a school by the sea, a lantern gone dark, a voice from tomorrow. Each original world comes with its own art and a chosen set of plugins. Where will you begin?",
    list: [
      {
        id: "mistport",
        name: "Mistport: The Riftide Chronicle",
        genre: "Dark fantasy · Investigation",
        summary:
          "Three strokes of the tide bell. A Guildmaster gone missing, a key in pieces. In a harbour that never sees the fog lift, four factions are waiting to learn whose side you will take.",
      },
      {
        id: "haruka-academy",
        name: "Harukaze Academy · Spring Mint",
        genre: "Campus · Visual novel",
        summary:
          "Twenty-one days until the school festival, and you are the new student. Between club rooms and the sea wall, find a place to belong—and the words for what has gone unsaid.",
      },
      {
        id: "lantern-barrow",
        name: "Lantern Barrow: The First Delve",
        genre: "Fantasy · Tabletop",
        summary:
          "For a hundred years, the lantern kept its watch. Now it is dark, and the bronze doors stand open. Gather your party, build your characters, and take the first roll into the depths.",
      },
      {
        id: "emberback",
        name: "Emberback Relay",
        genre: "Science fiction · Survival",
        summary:
          "On a world where day and night never trade places, an isolated relay receives a distress call. The voice is yours. The timestamp is seventy-two hours from now.",
      },
    ] satisfies WorldCopy[],
  },
  downloads: {
    title: "Pack for your next story.",
    body: "Choose a macOS or Windows build, wherever you are browsing. Download it here, or copy a link for later.",
    loading: "Looking up the latest release…",
    unavailable:
      "Downloads could not be listed. Find available files on GitHub Releases.",
    releases: "All releases & checksums",
    copy: "Copy link",
    copied: "Link copied",
    copyFailed: "Copy unavailable. Right-click the download link to copy it.",
    installer: "Installer",
    archive: "ZIP archive",
    portable: "Portable EXE",
    installerRecommended: "Recommended",
    action: "Download",
    macInstallerHelp: "Open the DMG, then drag Covel into Applications.",
    macArchiveHelp: "Extract the archive to get Covel.app.",
    installerHelp:
      "Install once and launch normally. The recommended choice for everyday use.",
    checking: "Checking availability…",
    notPublished: "Not included in the current release",
    notConfirmed: "Availability could not be confirmed",
    recommended: "Your system",
    missing: "No build listed for this system. Check GitHub Releases.",
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
  preview: previewZh,
  journey: journeyZh,
  workbench: workbenchZh,
  creation: creationZh,
  extensions: extensionsZh,
  ecosystem: ecosystemZh,
  meta: {
    docsPath: "",
    title: "Covel · 一切皆可插拔，每个世界都属于你",
    description:
      "Covel 是插件驱动的开源交互框架，专为多智能体叙事与演练打造：舞台、跑团与故事模式，全链路多语言，所有插件与世界皆可自定义。",
  },
  nav: {
    features: "核心系统",
    plugins: "插件体验",
    create: "创作",
    worlds: "世界",
    docs: "文档",
    download: "下载",
    languageLabel: "语言",
    menu: "菜单",
    quick: "快速导航",
    toLight: "切换到浅色主题",
    toDark: "切换到深色主题",
  },
  hero: {
    badge: "开源 · 抢先体验",
    tagline: "插件组成玩法，世界包装载故事。",
    lead: "写下属于你的",
    modes: [
      {
        visual: "stage",
        word: "视觉小说",
        body: "海风翻过书页，熟悉的身影走进画面。在逐句展开的对白里，选一句回答，让相遇有了下一章。",
        alt: "Covel 的舞台模式",
      },
      {
        visual: "tabletop",
        word: "跑团冒险",
        body: "提灯照亮墓门，骰子落定悬念。分配属性、携上行囊，在清晰的规则里冒险；每一次检定，都有迹可循。",
        alt: "跑团会话里的任务、行囊与好感",
      },
      {
        visual: "story",
        word: "长篇叙事",
        body: "一封来信，一句承诺，都可能让故事转向。循着线索前行，或走向另一条路；你做过的选择，渐渐成为世界的往事。",
        alt: "Covel 的故事模式",
      },
      {
        visual: "survival",
        word: "生存沙盒",
        body: "风暴将在三小时后抵达。诊所、车队与电台，都在等同一份电力。选择要守住的东西，让有限的资源，续上更多人的明天。",
        alt: "余烬岭中继站的电力、风暴与救援抉择",
      },
    ],
    modesLabel: "玩法",
    primary: "下载",
    primaryFor: { mac: "下载 macOS 版", windows: "Windows 安装版（推荐）" },
    otherPlatforms: "全部下载",
    pause: "暂停演示",
    play: "自动演示",
    zip: "ZIP 版 · 解压一次，免安装",
    zipHelp:
      "免安装。首次“全部解压缩”后，直接运行文件夹中的 Covel.exe；保留同目录文件，无需每次重新解包。",
    portable: "自解压 EXE · 免安装",
    portableHelp:
      "单文件便携版每次启动都要解包，可能需要等待；ZIP 版可避免重复解压。",
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
  pillars: foundationsZh,
  rack: {
    label: "世界插件组合 · 节选",
    packs: {
      stage: "遥风学园 · 视觉小说",
      tabletop: "提灯古冢 · 经典跑团",
      story: "传统故事模式",
      survival: "余烬岭中继站 · 生存沙盒",
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
      "world-init": "世界维度",
      soundtrack: "配乐",
    },
  },
  worlds: {
    eyebrow: "内置世界",
    title: "四个世界，四种启程。",
    body: "雾里的港口，海边的学园，熄灭的提灯，来自明日的声音。每个原创世界都备好了美术与插件。你想从哪一页开始？",
    list: [
      {
        id: "mistport",
        name: "雾港・裂潮纪",
        genre: "暗黑奇幻 · 推理",
        summary:
          "潮钟三鸣，公会长失踪，钥匙碎裂。在浓雾从未散去的港城，四方势力各藏心事，等你走入这场暗战。",
      },
      {
        id: "haruka-academy",
        name: "遥风学园・春日薄荷",
        genre: "校园 · 视觉小说",
        summary:
          "距离学园祭还有二十一天，你刚转入这所海边高中。在社团教室与放学后的海堤之间，寻找归处，也替未说出口的心意，找到一句回答。",
      },
      {
        id: "lantern-barrow",
        name: "提灯古冢・初次远征",
        genre: "奇幻 · 跑团",
        summary:
          "守望百年的提灯终于熄灭，青铜墓门向黑暗敞开。集结同伴，分配属性，让第一枚骰子带你走进古冢深处。",
      },
      {
        id: "emberback",
        name: "余烬岭中继站",
        genre: "科幻 · 生存",
        summary:
          "在昼夜不再交替的星球，一座孤立中继站收到求救信号。声音是你自己的，时间却来自七十二小时之后。",
      },
    ],
  },
  downloads: {
    title: "下一段故事，就此启程。",
    body: "无论正在用哪台设备，都可选择 macOS 或 Windows 版本。现在下载，或复制链接，留待启程时。",
    loading: "正在获取最新版本…",
    unavailable: "暂时无法列出下载文件，请前往 GitHub Releases 查看可用版本。",
    releases: "全部版本与校验文件",
    copy: "复制链接",
    copied: "链接已复制",
    copyFailed: "无法自动复制，请右键下载链接并复制链接地址。",
    installer: "安装版",
    archive: "ZIP 压缩包",
    portable: "Portable EXE",
    installerRecommended: "推荐",
    action: "下载",
    macInstallerHelp: "打开 DMG，将 Covel 拖入“应用程序”。",
    macArchiveHelp: "解压后即可获得 Covel.app。",
    installerHelp: "安装后正常启动，适合日常使用。",
    checking: "正在确认是否可下载…",
    notPublished: "当前版本未提供",
    notConfirmed: "暂时无法确认是否可下载",
    recommended: "当前系统",
    missing: "此版本未列出该系统的文件，请查看 GitHub Releases。",
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

export function isLang(value: unknown): value is Lang {
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
      const language = new Intl.Locale(tag).language;
      const match = LANGS.find((lang) => LANGUAGES[lang].match === language);
      if (match) return match;
    } catch {
      // An invalid tag says nothing; try the next one.
    }
  }
  return "en";
}

export function rememberLang(lang: Lang): void {
  const url = new URL(window.location.href);
  url.searchParams.set("lang", lang);
  window.history.replaceState(null, "", url);
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not remembered; the page still switches.
  }
}
