/** Editable example content, separate from layout. These are illustrative scenes,
 * not recordings or live sessions. Keep translated editions in the same shape. */
export const previewEn = {
  label: "Four ways into a story",
  example: "Illustrative preview",
  stage: {
    title: "Harukaze Academy",
    location: "Library · After school",
    speaker: "Mio",
    dialogue:
      "I left the last page blank. I thought… perhaps we could finish it together.",
    question: "How will you answer?",
    choices: [
      "Turn to the unfinished page",
      "Ask what she hopes for the festival",
    ],
  },
  tabletop: {
    title: "Lantern Barrow",
    chapter: "At the bronze doors",
    narrative:
      "Dust falls from the silver strokes as you lift the lantern. On the other side of the bronze, something holds its breath.",
    check: "Investigate the inscription",
    roll: "Intelligence check",
    result: "Success",
    calculation: "D20 · 16 + 4 = 20 / DC 16",
    questLabel: "Quest log",
    quest: "Find the Lampkeeper",
    objective: "Enter the bronze tomb doors",
    progress: "1 of 3 clues found",
    inventoryLabel: "Bag",
    items: ["Torch", "Rope · fifteen metres", "Healing draught"],
  },
  story: {
    title: "Mistport",
    chapter: "The third toll",
    turn: "Turn 12",
    paragraphs: [
      "At the third toll, the harbour lights go out. One lantern remains, in the window of a man who has been missing for days.",
      "A letter slides beneath your door. No footsteps follow. The ink is still wet.",
    ],
    quote: "What the sea remembers, we must not forget.",
    player: "I fold the letter into my coat and follow the last light.",
    choices: ["Follow the lantern", "Examine the seal"],
    composer: "What will you do next?",
  },
  survival: {
    title: "Last Train Out",
    chapter: "Two messages, one way out",
    signalLabel: "Control · 23:51",
    signal:
      "“Hold position. Do not detrain.” Kit's photo shows Wharf Street underwater.",
    narrative:
      "The train has stopped under the river, and water already covers the track bed. Lights, doors and radio all draw on one battery.",
    statusLabel: "Train watch",
    floodLabel: "Until the water reaches the battery",
    flood: "02:30:00",
    powerLabel: "Train battery",
    power: 72,
    systems: "Lights, radio and fans on low · doors and chargers off",
    taskLabel: "Choose your next move",
    choices: ["Check the photo with Kit", "Reach Theo's group on the walkway"],
    note: "Every choice spends time, charge or trust.",
  },
  languages: {
    title: "One tide. Many voices.",
    body: "Every way to play can speak your language. Covel’s interface supports Chinese, English and Russian; worlds can offer their own language editions, and the story follows your game language.",
    edition: "World editions",
    voices: [
      { tag: "zh-CN", name: "简体中文", text: "潮声带来了一封没有署名的信。" },
      {
        tag: "en",
        name: "English",
        text: "The tide brings a letter with no signature.",
      },
      {
        tag: "ru",
        name: "Русский",
        text: "Прилив приносит письмо без подписи.",
      },
    ],
  },
};

export const previewZh: typeof previewEn = {
  label: "故事的四种开场",
  example: "界面示例",
  stage: {
    title: "遥风学园",
    location: "图书馆 · 放学后",
    speaker: "神代澪",
    dialogue: "最后一页，我还空着。我想……也许，我们可以一起把它写完。",
    question: "你会怎样回应？",
    choices: ["翻到尚未写完的那页", "问她对学园祭的期待"],
  },
  tabletop: {
    title: "提灯古冢",
    chapter: "青铜门前",
    narrative:
      "你举起提灯，尘埃从银色铭文间簌簌落下。青铜门的另一边，有什么屏住了呼吸。",
    check: "调查门上的铭文",
    roll: "智识检定",
    result: "检定成功",
    calculation: "D20 · 16 + 4 = 20 / 难度 16",
    questLabel: "任务日志",
    quest: "寻找守灯人",
    objective: "穿过青铜墓门",
    progress: "已找到 1 / 3 条线索",
    inventoryLabel: "背包",
    items: ["火把", "麻绳（十五米）", "治疗药水"],
  },
  story: {
    title: "雾港",
    chapter: "潮钟第三鸣",
    turn: "第 12 回合",
    paragraphs: [
      "潮钟第三鸣，沿港的灯火尽数熄灭。只有失踪多日的会长窗前，仍亮着一盏提灯。",
      "一封信从门缝里滑进来。门外没有脚步声，纸上的墨迹却还未干。",
    ],
    quote: "大海记得的事，我们不该遗忘。",
    player: "我把信折进外衣，循着最后的灯火走去。",
    choices: ["循着灯光前行", "检查信封上的封蜡"],
    composer: "接下来，你想做什么？",
  },
  survival: {
    title: "末班地铁",
    chapter: "两条消息，一条出路",
    signalLabel: "调度 · 23:51",
    signal: "“原地等待，不要下车。”基特的照片里，码头街已经淹了。",
    narrative:
      "列车停在河底，水已经漫过道床。照明、车门和无线电，都在消耗同一块电池。",
    statusLabel: "列车值守",
    floodLabel: "距离水淹电池箱",
    flood: "02:30:00",
    powerLabel: "列车电池",
    power: 72,
    systems: "照明、无线电、通风低档 · 车门与充电关闭",
    taskLabel: "下一步，由你抉择",
    choices: ["和基特核实照片", "沿疏散平台联系西奥一行"],
    note: "每个决定，都要付出时间、电力或信任。",
  },
  languages: {
    title: "同一片潮声，不同的回响。",
    body: "无论选择哪种玩法，都可以用熟悉的语言走入故事。Covel 的界面支持中、英、俄；世界可提供不同语言版本，故事始终跟随游戏语言。",
    edition: "世界语言版本",
    voices: [
      { tag: "zh-CN", name: "简体中文", text: "潮声带来了一封没有署名的信。" },
      {
        tag: "en",
        name: "English",
        text: "The tide brings a letter with no signature.",
      },
      {
        tag: "ru",
        name: "Русский",
        text: "Прилив приносит письмо без подписи.",
      },
    ],
  },
};

/** Paths are relative to public/. Replace artwork here without changing layout. */
export const PREVIEW_ART = {
  stageDay: "previews/library-day.webp",
  stageNight: "previews/library-night.webp",
  character: "previews/mio.webp",
  story: "worlds/mistport.webp",
  tabletop: "worlds/lantern-barrow.webp",
  survival: "worlds/last-train.webp",
};
