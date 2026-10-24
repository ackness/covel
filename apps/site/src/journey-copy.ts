/** Three authored moments per world; sample outcomes, never live plugin execution. */
export const journeyEn = {
  label: "Follow one turn",
  source: "World configuration",
  stage: [
    {
      title: "A scene opens",
      body: "Scene Stage places Mio in the library; the dialogue narrator gives her the next line.",
    },
    {
      title: "You answer",
      body: "The Guide offers a way forward. Your reply gives the conversation a direction.",
    },
    {
      title: "The moment stays",
      body: "Affinity records a little more trust. The world’s route panel keeps its own relationship stage.",
    },
  ],
  tabletop: [
    {
      title: "Choose a check",
      body: "Tabletop Rules supplies the Intelligence check. Dice Check resolves the roll.",
    },
    {
      title: "Read the result",
      body: "The receipt keeps the die, modifier and difficulty visible: 16 + 4 beats 16.",
    },
    {
      title: "Carry it forward",
      body: "The quest log marks an objective; the inventory keeps your adventuring kit close.",
    },
  ],
  story: [
    {
      title: "Follow the story",
      body: "The narrator unfolds the letter. The Guide offers the next paths through Mistport.",
    },
    {
      title: "Keep the clue",
      body: "The codex gives the Guild Tower a permanent entry; story memory keeps the letter in reach.",
    },
    {
      title: "Connect the case",
      body: "The world’s Case Board tracks confirmed leads through World Dimensions. The investigation has moved on.",
    },
  ],
  survival: [
    {
      title: "Hear the call",
      body: "The narrator brings a future distress call into the present. The relay’s world panels show what is at stake.",
    },
    {
      title: "Take the assignment",
      body: "The quest log follows the rescue; the field inventory holds the equipment you can bring.",
    },
    {
      title: "See the cost",
      body: "World Time advances the storm countdown; World Dimensions records the shared grid’s running cost.",
    },
  ],
  stageState: {
    label: "Mio · Affinity",
    before: "A little trust · +8",
    after: "A promise kept · +10",
    reply: "Then let’s write that last page together.",
    route: "Route: getting acquainted",
  },
  tabletopState: {
    pending: "Ready to roll · D20 + 4 / DC 16",
    waiting: "Awaiting the roll",
    before: "1 / 3 objectives",
    after: "2 / 3 objectives",
    done: "The bronze doors are behind you",
  },
  storyState: {
    label: "Codex · Location",
    entry: "Tidewatch Guild Tower",
    description: "The guild’s records may hold a trace of its missing master.",
    caseLabel: "Case Board",
    before: "Torn letter · unverified",
    after: "Torn letter · corroborated",
    memory: "Remembered: the unsigned letter",
  },
  survivalState: {
    questLabel: "Quest log",
    quest: "Three Hours of Power",
    equipment: "Field inventory · field radio, linekeeper kit",
    cost: "Shared grid running · reserve −3",
    elapsed: "Ten minutes later",
    before: "Clinic at full power · other systems on standby",
  },
};

export const journeyZh: typeof journeyEn = {
  label: "看一回合，如何留下变化",
  source: "查看世界配置",
  stage: [
    {
      title: "相遇入画",
      body: "场景舞台把澪带进图书馆，对话叙事接上她未说完的话。",
    },
    {
      title: "一句回应",
      body: "行动建议递来下一步。你选的一句话，让这场相遇有了方向。",
    },
    {
      title: "心意留痕",
      body: "好感度记下多一点的信任；世界自己的心之路线面板，另行记录关系阶段。",
    },
  ],
  tabletop: [
    {
      title: "发起检定",
      body: "跑团规则提供智识检定，骰子判定让这次冒险有了可见的结果。",
    },
    {
      title: "骰点落定",
      body: "骰点、修正和难度写在同一份记录里：16 + 4，通过难度 16。",
    },
    {
      title: "继续远征",
      body: "任务日志记下完成的目标，行囊保管仍在身边的装备。",
    },
  ],
  story: [
    {
      title: "循信入局",
      body: "叙事者展开来信，行动建议留下几条通向雾港深处的路。",
    },
    {
      title: "线索入册",
      body: "图鉴收下验潮师公会塔，故事记忆留住那封信，不让线索淹没在旧对话里。",
    },
    {
      title: "案情推进",
      body: "世界维度承载雾港自定义的案情板。一条线索被确认，调查便向前走了一步。",
    },
  ],
  survival: [
    {
      title: "远方来电",
      body: "叙事者把未来的求救送到此刻，中继站的世界面板呈现眼前的危机。",
    },
    {
      title: "接下救援",
      body: "任务日志记着诊所的安危，行囊里装着能带去现场的工具。",
    },
    {
      title: "代价可见",
      body: "世界时间推动风暴倒计时，世界维度记下共享电网运转所花去的储备。",
    },
  ],
  stageState: {
    label: "神代澪 · 好感度",
    before: "一点信任 · +8",
    after: "守住约定 · +10",
    reply: "那就一起，把最后一页写完吧。",
    route: "心之路线：初识",
  },
  tabletopState: {
    pending: "等待掷骰 · D20 + 4 / 难度 16",
    waiting: "等待检定",
    before: "已完成 1 / 3 项目标",
    after: "已完成 2 / 3 项目标",
    done: "已穿过青铜墓门",
  },
  storyState: {
    label: "图鉴 · 地点",
    entry: "验潮师公会塔",
    description: "公会留存的旧档，也许藏着会长失踪前的行迹。",
    caseLabel: "案情板",
    before: "半封信 · 未核实",
    after: "半封信 · 已佐证",
    memory: "故事记忆：那封没有署名的信",
  },
  survivalState: {
    questLabel: "任务日志",
    quest: "三小时的电力",
    equipment: "行囊 · 野外电台、线路维护工具包",
    cost: "共享电网运转 · 电力储备 −3",
    elapsed: "十分钟后",
    before: "诊所全功率 · 其余系统待命",
  },
};
