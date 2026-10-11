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

const en = {
  meta: {
    title: "Covel · An AI game master with a good memory",
    description:
      "Covel is a free, open-source AI role-playing game. It runs on your own computer with your own model key, rolls real dice, and remembers what you did.",
  },
  nav: {
    play: "Getting started",
    worlds: "Worlds",
    features: "Why Covel",
    creators: "Plugins",
    download: "Download",
    language: "中文",
    languageLabel: "切换到中文",
    menu: "Menu",
    toLight: "Use the light theme",
    toDark: "Use the dark theme",
  },
  hero: {
    badge: "Open source · Still early",
    titleA: "An AI game master",
    titleB: "with a good memory.",
    body: "The clue you asked about in Mistport, the promise you made at Haruka Academy, every roll you made under the barrow: it remembers all of it. Covel is free and open source, and it runs on your own computer with your own model key.",
    primary: "Download",
    primaryFor: { mac: "Download for macOS", windows: "Download for Windows" },
    otherPlatforms: "Other systems and checksums",
    portable: "Portable version, no install",
    secondary: "Source on GitHub",
    note: "macOS (Apple silicon) and Windows x64 · MIT licensed",
    videoLabel: "A Covel session being played",
  },
  play: {
    eyebrow: "Getting started",
    title: "Getting a game going",
    steps: [
      {
        title: "Pick a world",
        body: "Start with one of the four that come with it. Go to Mistport if you want a case to crack, or Haruka Academy if you want a crush.",
      },
      {
        title: "Add a model key",
        body: "OpenAI, Anthropic, DeepSeek or Qwen. You can give the storytelling and the bookkeeping to two different models, so the expensive one only does the part that needs it.",
      },
      {
        title: "Say what you do",
        body: "Type it the way you'd say it: “I put the key fragment on the table and watch his face.” When a roll is called for, it rolls first and tells the story after.",
      },
    ] satisfies Item[],
  },
  worlds: {
    eyebrow: "Worlds",
    title: "Four to start with",
    body: "We wrote these ourselves, with character portraits and scene art. When you want something else, describe a world in a sentence, let Covel draft it, and edit from there.",
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
  features: {
    eyebrow: "Why Covel",
    title: "What it does that a chatbot doesn't",
    items: [
      {
        title: "NPCs hold grudges",
        body: "After each turn it writes down who did what to whom. Someone you crossed will remember it the next time you meet.",
      },
      {
        title: "The dice don't cheat",
        body: "Checks are real rolls. The result is settled before the model tells the story, and you can scroll back to see every number.",
      },
      {
        title: "It can turn into a visual novel",
        body: "Stage mode puts up the backdrop, the portraits and a dialogue box, much like a galgame.",
      },
      {
        title: "Your saves stay on your machine",
        body: "Sessions are stored locally, and your model key is saved only on your device. There's no account to sign up for.",
      },
      {
        title: "When something's off, you can look",
        body: "If the model suddenly goes off the rails, open the debugger. Every call is there, with what went in and what came back.",
      },
      {
        title: "Chinese, English, Russian",
        body: "The interface comes in three languages, and every bundled world has a Chinese and an English edition.",
      },
    ] satisfies Item[],
  },
  creators: {
    eyebrow: "Plugins",
    title: "Don't like a rule? Write your own.",
    body: "The narrator, the dice, the quests and the inventory are all plugins, built on the same interface you'd use. The simplest plugin is a single PLUGIN.md: a few lines on when it runs, then what to tell the model. Add some JavaScript where you need actual arithmetic.",
    links: [
      { label: "Writing plugins", href: "docs/guide/plugin-authoring.md" },
      { label: "Packaging a world", href: "docs/guide/collections.md" },
      { label: "What happens in a turn", href: "docs/architecture/flow.md" },
    ],
    fileLabel: "plugins/observation/PLUGIN.md",
  },
  cta: {
    title: "Go pick a world.",
    body: "Download it, add your key, and write your first line.",
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
    title: "Covel · 一个记性很好的 AI 跑团主持人",
    description:
      "Covel 是免费开源的 AI 文字角色扮演游戏。装在你自己的电脑上，用你自己的模型密钥，骰子是真掷的，你做过的事它都记得。",
  },
  nav: {
    play: "怎么开始",
    worlds: "世界",
    features: "有什么不同",
    creators: "插件",
    download: "下载",
    language: "EN",
    languageLabel: "Switch to English",
    menu: "菜单",
    toLight: "切换到浅色主题",
    toDark: "切换到深色主题",
  },
  hero: {
    badge: "开源 · 还在早期",
    titleA: "一个记性很好的",
    titleB: "AI 跑团主持人。",
    body: "你在雾港问过的线索，在学园许下的约定，在古冢里掷出的每一次骰子，它都记着。Covel 免费、开源，装在你自己的电脑上，用你自己的模型密钥。",
    primary: "下载",
    primaryFor: { mac: "下载 macOS 版", windows: "下载 Windows 版" },
    otherPlatforms: "其他系统和校验文件",
    portable: "便携版（免安装）",
    secondary: "GitHub 源码",
    note: "macOS（Apple 芯片）和 Windows x64 · MIT 许可",
    videoLabel: "一局 Covel 会话的录屏",
  },
  play: {
    eyebrow: "怎么开始",
    title: "开一局要做的事",
    steps: [
      {
        title: "选个世界",
        body: "先从内置的四个里挑一个。想查案就去雾港，想谈恋爱就去遥风学园。",
      },
      {
        title: "填上模型密钥",
        body: "OpenAI、Anthropic、DeepSeek、通义千问都行。讲故事和记账可以交给两个模型，贵的那个只用在要紧的地方。",
      },
      {
        title: "说你要做什么",
        body: "像平时说话那样写，比如“我把钥匙碎片放到桌上，看他什么反应”。需要掷骰的时候，它先掷，再往下讲。",
      },
    ],
  },
  worlds: {
    eyebrow: "世界",
    title: "先玩这四个",
    body: "都是我们自己写的，带角色立绘和场景图。想换口味的话，用一句话描述你想要的世界，让 Covel 先起个草稿，你再慢慢改。",
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
  features: {
    eyebrow: "有什么不同",
    title: "和聊天机器人不一样的地方",
    items: [
      {
        title: "NPC 会记仇",
        body: "每回合结束，它会把谁对谁做了什么记下来。你得罪过的人，下次见面态度就不一样了。",
      },
      {
        title: "骰子不作弊",
        body: "检定是真掷的。点数先定下来，模型再照着讲，往回翻能看到每一次掷了几点。",
      },
      {
        title: "能切成视觉小说",
        body: "打开舞台模式，背景、立绘和对话框就出来了，玩起来跟 galgame 差不多。",
      },
      {
        title: "存档在你自己电脑上",
        body: "会话存在本地，模型密钥也只保存在你的设备上。不用注册账号。",
      },
      {
        title: "出了怪事能查",
        body: "模型突然开始胡说的时候，打开调试页看看：每次调用发了什么、回了什么，都在那里。",
      },
      {
        title: "中文、英文、俄文",
        body: "界面有三种语言，内置的世界都有中英两个版本。",
      },
    ],
  },
  creators: {
    eyebrow: "插件",
    title: "不喜欢某条规则？自己写一个。",
    body: "叙事、骰子、任务、背包都是插件，用的就是你能用的那套接口。最简单的插件只有一个 PLUGIN.md：开头几行写它什么时候跑，下面写给模型的话。真要算数的地方，再补一段 JavaScript。",
    links: [
      { label: "写插件", href: "docs/guide/plugin-authoring.md" },
      { label: "打包一个世界", href: "docs/guide/collections.md" },
      { label: "一个回合里发生了什么", href: "docs/architecture/flow.md" },
    ],
    fileLabel: "plugins/observation/PLUGIN.md",
  },
  cta: {
    title: "去挑个世界吧。",
    body: "下载、装好、填上密钥，然后写下你的第一句话。",
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
