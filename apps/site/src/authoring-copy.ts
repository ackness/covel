/** The homepage's product explanation and creation paths, separate from demo prose. */
export const foundationsEn = {
  eyebrow: "Plugins × world packs",
  title: "Give the story its workings. Give it a world.",
  body: "Covel is an open-source AI roleplaying framework. Plugins provide the things a story can do; world packs give it a setting, a cast and a place to begin. Combine them to make the experience your own.",
  plugin: {
    title: "The plugin system",
    body: "Narration, dice, memory and panels are pieces you can choose, extend or replace—even the ones that come with Covel.",
    diagramTitle: "Start with a narrator",
    diagramNote: "Add only what this story needs.",
    modules: ["Dice", "Quests", "Memory", "Relationships"],
    points: [
      {
        title: "Small enough for a conversation",
        body: "One narrative plugin is enough to play. Add tools, rules and interfaces as your story asks for them.",
      },
      {
        title: "Open to a different way of playing",
        body: "Write or install a plugin to add new behavior through the public author API, without changing the kernel.",
      },
    ],
  },
  world: {
    title: "The world-pack system",
    body: "A world pack holds lore, characters, starting data and art. It chooses plugins and configures their rules; the pack itself contains no gameplay code.",
    diagramTitle: "One world, an open folder",
    files: [
      { path: "world.yaml", label: "Identity & plugin choices" },
      { path: "WORLD.md", label: "Setting & opening" },
      { path: "characters/", label: "The people you will meet" },
      { path: "data/ · media/", label: "World data & artwork" },
    ],
    points: [
      {
        title: "Yours to read and revise",
        body: "Change a character, prepare a quest or redraw the setting. Making a world does not require programming.",
      },
      {
        title: "A setting, more than one way in",
        body: "Choose a different set of plugins for the same world. Publish a world pack on its own, or bundle it with plugins in a collection.",
      },
    ],
  },
  links: [
    { label: "How plugins work", href: "plugins/essentials.html" },
    { label: "Inside a world pack", href: "worlds/index.html" },
  ],
};

export const foundationsZh: typeof foundationsEn = {
  eyebrow: "插件 × 世界包",
  title: "插件写下玩法，世界包安放故事。",
  body: "Covel 是一个开源的 AI 角色扮演框架。插件提供叙事、工具与交互，世界包装入设定、人物和开篇。把它们组合起来，才有了你想走入的世界。",
  plugin: {
    title: "插件系统",
    body: "叙事、骰子、记忆和面板，都是可以选择、扩展或替换的组成部分。随 Covel 提供的插件，也遵循同一套接口。",
    diagramTitle: "从一位叙事者开始",
    diagramNote: "故事需要什么，就添上什么。",
    modules: ["骰点", "任务", "记忆", "人物关系"],
    points: [
      {
        title: "一段对话，也能成行",
        body: "只启用一个叙事插件就能游玩。随着故事需要，再添上工具、规则与界面。",
      },
      {
        title: "让新的玩法，有处落脚",
        body: "通过公开的作者接口开发或安装插件，为游戏添一种能力，不必改动框架内核。",
      },
    ],
  },
  world: {
    title: "世界包系统",
    body: "设定、人物、开局数据与美术，都收在世界包里。它选择插件、配置规则，本身不承载玩法代码。",
    diagramTitle: "一方天地，一个公开的文件夹",
    files: [
      { path: "world.yaml", label: "世界信息与插件组合" },
      { path: "WORLD.md", label: "世界设定与故事开篇" },
      { path: "characters/", label: "将要相遇的人物" },
      { path: "data/ · media/", label: "世界数据与美术素材" },
    ],
    points: [
      {
        title: "写世界，不必先学编程",
        body: "改一个人物，埋一条任务，重写一段往事。世界内容公开可读，也随时可以接着修改。",
      },
      {
        title: "同一片天地，不同的走法",
        body: "为同一个世界搭配不同插件。世界包可以独立分享，也可以和所需插件一起打成合集。",
      },
    ],
  },
  links: [
    { label: "了解插件系统", href: "plugins/essentials.html" },
    { label: "了解世界包", href: "worlds/index.html" },
  ],
};

export const creationEn = {
  eyebrow: "Make something of your own",
  title: "Begin with an idea. Give it somewhere to live.",
  body: "Players and developers can both become world makers. Start inside Covel, or work with a coding assistant to shape the files and the rules yourself.",
  app: {
    title: "Build a world in the app",
    body: "Connect a model, open “AI Create World”, and describe your idea. Choose the content and play style, then press “Start Building”. The agent builds and checks the world, saves it, and leaves it ready for you to keep editing.",
    label: "Worldbuilding agent · example",
    prompt:
      "A city built inside a sleeping giant. Each time it dreams, the streets move.",
    promptLabel: "The idea",
    steps: ["Authoring", "Consistency check", "Packaging"],
    result: "A world you can keep shaping",
    parts: [
      "Setting & opening",
      "Characters & relationships",
      "Rules & starting data",
    ],
    link: "Start creating in Covel",
  },
  skills: {
    title: "Create with Agent Skills",
    body: "In a code workspace, give a coding assistant your brief and the relevant skill. It can write and validate world packs or plugins against Covel’s current authoring contracts.",
    installTitle: "Install the authoring skills",
    installNote:
      "Run in a prepared Covel source workspace with Node.js and npx available. Choose the coding assistant you use; then describe what you want to create.",
    copyCommand: "Copy skills install command",
    copied: "Command copied",
    copyFailed: "Select the command above to copy it manually.",
    sourceLabel: "Read SKILL.md",
    worldTitle: "Write a world pack",
    worldBody:
      "Turn a setting into lore, characters, starting content and a suitable plugin combination.",
    pluginTitle: "Build a new capability",
    pluginBody:
      "Develop a rule, tool or panel as a reusable plugin, then validate and test it.",
    note: "These skills guide a coding assistant in your workspace. They are separate from the app’s worldbuilding agent.",
    link: "Agent Skills guide",
  },
};

export const creationZh: typeof creationEn = {
  eyebrow: "从游玩，到创作",
  title: "给一个念头，一片可以生长的天地。",
  body: "玩家和开发者，都可以成为造世界的人。在应用里开始构筑，或与编程助手一起，把设定与玩法写进自己的文件。",
  app: {
    title: "在应用里，一键开始构筑",
    body: "接入模型，打开“AI 创建世界”，写下核心创意，选择内容与玩法，再点“开始构筑”。Agent 会创作、校验并保存世界，之后你可以继续编辑。",
    label: "世界构筑 Agent · 流程示例",
    prompt: "一座建在沉睡巨人身上的城市。每当它做梦，街道便会改变方向。",
    promptLabel: "核心创意",
    steps: ["创作内容", "检查一致性", "封装世界包"],
    result: "世界成形，仍可继续改写",
    parts: ["设定与开篇", "人物与关系", "规则与开局数据"],
    link: "查看应用内创作指南",
  },
  skills: {
    title: "用 Agent Skills，写自己的世界与玩法",
    body: "在代码工作区，把创作意图和对应 Skill 交给编程助手。它可以按 Covel 当前的作者契约编写并校验世界包或插件。",
    installTitle: "安装创作技能",
    installNote:
      "准备好 Covel 源码工作区与 Node.js / npx，在终端运行命令，选择你使用的编程助手，再向它描述创作意图。",
    copyCommand: "复制技能安装命令",
    copied: "命令已复制",
    copyFailed: "请选中上方命令手动复制。",
    sourceLabel: "阅读 SKILL.md 原文",
    worldTitle: "写一个世界包",
    worldBody: "把构想展开成设定、人物、开局内容与合适的插件组合。",
    pluginTitle: "添一种新玩法",
    pluginBody: "把规则、工具或面板做成可复用的插件，再完成校验与测试。",
    note: "这两份 Skill 供工作区里的编程助手使用，与应用内的世界构筑 Agent 是两条创作入口。",
    link: "阅读 Agent Skills 指南",
  },
};

export const ecosystemEn = {
  title: "Beyond the bundled worlds",
  body: "Two growing GitHub directories bring together official examples and community submissions. Browse the source, find a starting point, or contribute your own work.",
  plugins: "Optional plugins & authoring examples",
  worlds: "World examples & community entries",
  guide: "Installing & sharing packages",
};
export const ecosystemZh: typeof ecosystemEn = {
  title: "更多创作，正在汇聚。",
  body: "两个持续建设的 GitHub 目录，收录官方示例与社区投稿。你可以从中寻找素材与思路，也可以提交自己的作品。",
  plugins: "可选插件与开发示例",
  worlds: "世界示例与社区条目",
  guide: "了解安装与分享",
};

export const extensionsEn = {
  title: "Four examples. Many more possibilities.",
  body: "These are a few ways to try Covel’s plugins, not the limits of the system. Add an image, give the prose a voice, or build the rule your world is missing.",
  images: {
    title: "Let the story take shape",
    body: "Generate illustrations from the story and keep them in a gallery. Optional OpenAI Images and DashScope Images plugins provide different image pipelines.",
  },
  voice: {
    title: "Give the words a voice",
    body: "MiMo Narration adds speech synthesis, with automatic or manual narration and an audio panel to listen back.",
  },
  more: {
    title: "Keep making room",
    body: "Inventory, memory, music, hidden events and new mechanics can all find their place. Combine existing plugins or write one of your own.",
    link: "Explore the bundled plugins",
  },
  note: "Image and speech plugins are optional installations. Configure the corresponding model services before using them.",
};
export const extensionsZh: typeof extensionsEn = {
  title: "四个例子，远不止四种可能。",
  body: "这里试玩的，只是插件系统的一角。让文字有画面，让故事有声音，或为自己的世界添一条从未有过的规则。",
  images: {
    title: "让文字，长出画面",
    body: "为故事生成插图，收进一路积累的画廊。OpenAI Images 与 DashScope Images 提供不同的生图路径，可按需安装。",
  },
  voice: {
    title: "让叙事，有声可循",
    body: "MiMo Narration 提供语音合成，可自动朗读或手动触发，在音频面板里听见故事。",
  },
  more: {
    title: "为新的玩法，留一扇门",
    body: "行囊、记忆、配乐、隐藏事件，以及你尚未写出的机制，都可以成为插件。组合已有能力，也可以亲手添一种。",
    link: "浏览随附插件",
  },
  note: "生图与语音属于可选扩展，需另行安装，并配置对应的模型服务。",
};
