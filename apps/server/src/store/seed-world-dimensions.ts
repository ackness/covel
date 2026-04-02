/**
 * Structured dimension data for seed worlds.
 *
 * Each export corresponds to a seed world in seed-worlds.ts and provides
 * the full WorldDimensions complement (geography, factions, power system,
 * history, economy, social structure, tone, mechanics, starting conditions).
 */

import type { WorldDimensions } from "@covel/shared";

// ── World 1: 雾港・裂潮纪 (zh-CN) ──────────────────────────

export const MISTPORT_DIMENSIONS: WorldDimensions = {
  geography: {
    overview: "悬崖与海面之间的港口城市，永恒灰白浓雾笼罩，能见度不超过五十步。",
    regions: [
      {
        name: "上城",
        description: "议会与商会所在地，位于悬崖顶部，建筑以石砌为主。",
        climate: "雾气稀薄，偶见天光",
        landmarks: [
          { name: "议事厅", description: "议会权力中枢，穹顶嵌有远古潮石灯。" },
          { name: "验潮师公会塔", description: "鉴定远古遗物的学术要地。" },
        ],
      },
      {
        name: "中港",
        description: "码头、工坊和旅店聚集地，城市的经济心脏。",
        climate: "浓雾常驻，潮湿闷热",
        landmarks: [
          { name: "主栈桥", description: "雾港唯一的大型泊位，渡船与货船在此停靠。" },
          { name: "钟塔", description: "以潮汐驱动的机械钟，标记退潮与涨潮。" },
        ],
      },
      {
        name: "下潮区",
        description: "潮退后暴露的远古遗迹区域，地形每次退潮都会改变。",
        climate: "阴冷，弥漫盐雾与腐蚀气息",
        landmarks: [
          { name: "骨拱门", description: "半淹没的巨大拱形结构，来源不明。" },
        ],
      },
    ],
  },

  factions: [
    {
      id: "council",
      name: "雾港议会",
      description: "统治上城的政治实体，试图以'封潮令'限制平民进入下潮区。",
      type: "political",
      influence: "major",
      leader: "陈议长",
      headquarters: "上城・议事厅",
      relations: [
        { targetId: "salt-fangs", type: "hostile", description: "视盐牙会为非法组织" },
      ],
    },
    {
      id: "tide-readers",
      name: "验潮师公会",
      description: "负责鉴定远古遗物、研究潮汐规律的学术组织。",
      type: "guild",
      influence: "major",
      leader: "公会长・齐老",
      headquarters: "上城・验潮师公会塔",
      relations: [
        { targetId: "council", type: "allied", description: "依赖议会资金，提供遗物鉴定" },
      ],
    },
    {
      id: "salt-fangs",
      name: "盐牙会",
      description: "控制下潮区遗物黑市的走私帮派，势力在底层根深蒂固。",
      type: "criminal",
      influence: "major",
      leader: "铁姑",
      headquarters: "下潮区・隐潮窟",
      relations: [
        { targetId: "council", type: "hostile", description: "长期对抗议会封锁政策" },
      ],
    },
  ],

  powerSystem: {
    name: "潮力",
    type: "magic",
    description: "远古遗物蕴含的不可预测能量，与潮汐周期共振。验潮师可引导并稳定其效果。",
    rules: [
      "遗物效果因潮汐相位而异，满潮时最强、退潮时最稳",
      "未经鉴定的遗物直接使用可能产生反噬",
      "雾兽被潮力波动吸引，大规模使用遗物会引来雾兽群",
      "验潮师通过'潮纹'手法引导能量，需要长期训练",
    ],
    tiers: [
      { name: "学徒", rank: 1, description: "能感知遗物是否活性" },
      { name: "验潮师", rank: 2, description: "可鉴定并稳定常规遗物" },
      { name: "御潮者", rank: 3, description: "能主动引导潮力，极为罕见" },
    ],
  },

  history: [
    {
      era: "远古",
      name: "造者时代",
      description: "下潮区遗迹的建造者文明，已无文字记录，仅余建筑残骸。",
      significance: "major",
    },
    {
      era: "建城纪",
      year: "约三百年前",
      name: "雾港建城",
      description: "流民在悬崖间搭建栈道定居，发现退潮暴露的遗物可以交易。",
      significance: "major",
    },
    {
      era: "当代",
      year: "去年",
      name: "封潮令草案",
      description: "陈议长提出封潮令，禁止无证者进入下潮区，引发底层激烈反对。",
      significance: "minor",
    },
  ],

  economy: {
    currencies: [
      { name: "潮币", symbol: "₮", description: "议会发行的标准货币" },
      { name: "盐牙筹", description: "盐牙会在黑市流通的代币" },
    ],
    resources: ["远古遗物", "潮盐", "雾菌（可食用真菌）", "崖铁"],
    tradeNotes: "遗物交易是雾港经济的核心。合法渠道走验潮师公会鉴定后拍卖，黑市走盐牙会。",
  },

  socialStructure: {
    classes: [
      { name: "议员与商会", rank: 1, description: "上城精英，掌握政治与合法贸易权" },
      { name: "中港市民", rank: 2, description: "码头工人、工匠、旅店主，城市运转的中坚" },
      { name: "潮民", rank: 3, description: "下潮区居民，靠拾荒和走私为生" },
    ],
    notes: "验潮师公会成员不受阶层限制，凭技术获得跨阶层通行权。",
  },

  tone: {
    genres: ["dark-fantasy", "mystery", "exploration"],
    contentRating: "teen",
    narrativeStyle: "雾气氤氲的哥特悬疑风格，节奏舒缓但暗流涌动。",
    themes: ["阶层对立", "未知探索", "权力与秩序"],
  },

  mechanics: {
    combatStyle: "narrative",
    skillSystem: "以职业技能树为核心：验潮（鉴定/引导遗物）、潜行（雾中行动）、交涉（社交）、格斗。",
    difficulty: "normal",
    customRules: [
      "雾中行动需声音/光源检定，失败则引来雾兽",
      "遗物使用前必须鉴定，否则触发随机效果表",
      "潮汐周期影响下潮区可探索范围",
    ],
  },

  startingConditions: {
    openingScenario:
      "你刚抵达雾港中港的主栈桥。潮汐钟敲响——一次罕见的深退潮即将发生。码头上有人在招募深潮探险队，也有人在发放封潮令传单。",
    playerConstraints: [
      "初始为验潮师学徒或普通潮民",
      "不可携带明火进入雾区",
    ],
    startingLocation: "中港・主栈桥",
    startingResources: { 潮币: 50, 雾灯: 1 },
  },
};

// ── World 2: 霓虹脊・2087 (zh-CN) ──────────────────────────

export const NEONRIDGE_DIMENSIONS: WorldDimensions = {
  geography: {
    overview: "垂直发展的巨型城市，底层永夜，顶层空中庭园。义体改造是生存的基础。",
    regions: [
      {
        name: "顶层・云庭",
        description: "企业集团的总部与高管住宅区，阳光充沛，空气经过净化。",
        climate: "人工恒温，天气可控",
        landmarks: [
          { name: "寰宇科技天穹塔", description: "全城最高建筑，集团总部兼数据中枢。" },
        ],
      },
      {
        name: "中层・霓虹带",
        description: "商业区和中产住宅区，霓虹灯永不熄灭。",
        climate: "人工光照，温度适宜但空气质量一般",
        landmarks: [
          { name: "中央义体诊所", description: "官方授权的义体维护设施。" },
        ],
      },
      {
        name: "底层・暗沟",
        description: "信号屏蔽的贫民窟，阳光无法抵达，靠废热和泄漏管道供暖。",
        climate: "潮湿闷热，空气含有微量工业废气",
        landmarks: [
          { name: "虹姐信号站", description: "底层信息网络的中枢，靠物理线路运作。" },
          { name: "第三区废弃充能站", description: "已停用的义体充能设施，传闻有人秘密使用。" },
        ],
      },
    ],
  },

  factions: [
    {
      id: "huanyu-tech",
      name: "寰宇科技",
      description: "控制城市主网与数据基础设施的科技巨头。",
      type: "corporate",
      influence: "major",
      headquarters: "顶层・天穹塔",
      relations: [
        { targetId: "redflame-sec", type: "allied", description: "雇佣赤焰执行安保合同" },
        { targetId: "deepblue-pharma", type: "neutral", description: "商业竞争但互不侵犯" },
      ],
    },
    {
      id: "redflame-sec",
      name: "赤焰安保",
      description: "私人军事安保企业，控制城市武装力量与边境通行。",
      type: "military",
      influence: "major",
      headquarters: "中层・赤焰堡",
      relations: [
        { targetId: "huanyu-tech", type: "allied" },
        { targetId: "free-bodies", type: "hostile", description: "将自由体视为安全威胁" },
      ],
    },
    {
      id: "deepblue-pharma",
      name: "幽蓝制药",
      description: "垄断义体维护药剂与生物兼容液的制药集团。",
      type: "corporate",
      influence: "major",
      headquarters: "顶层・幽蓝生命园区",
    },
    {
      id: "free-bodies",
      name: "自由体",
      description: "拒绝义体改造的稀有群体，被底层人崇拜、被企业列为危险分子。",
      type: "other",
      influence: "minor",
      relations: [
        { targetId: "redflame-sec", type: "hostile" },
      ],
    },
  ],

  powerSystem: {
    name: "义体技术",
    type: "technology",
    description: "通过植入机械义体增强人体能力。超过70%居民至少有一处义体，但维护成本是底层人的枷锁。",
    rules: [
      "义体过载触发'金属热'——排异反应导致抽搐甚至义体失控",
      "义体需定期充能和维护，否则性能衰减直至瘫痪",
      "底层信号屏蔽区无法远程诊断义体，只能依赖黑市技师",
      "军用级义体仅限赤焰安保持有，民间持有属重罪",
    ],
    tiers: [
      { name: "民用级", rank: 1, description: "基础肢体替换与感官增强" },
      { name: "商用级", rank: 2, description: "高性能运动/计算义体，需企业授权" },
      { name: "军用级", rank: 3, description: "武器化义体与战术神经接口" },
      { name: "实验级", rank: 4, description: "未公开的前沿原型，存在严重风险" },
    ],
  },

  history: [
    {
      era: "建城纪",
      year: "2041",
      name: "霓虹脊奠基",
      description: "三大企业联合投资建造垂直城市，以应对沿海地区环境崩溃。",
      significance: "major",
    },
    {
      era: "义体纪",
      year: "2058",
      name: "全民义体化政策",
      description: "幽蓝制药推出廉价义体套件，义体改造率从15%飙升至70%。",
      significance: "major",
    },
    {
      era: "当代",
      year: "2085",
      name: "底层信号封锁",
      description: "寰宇科技以安全为由切断底层主网接入，底层通讯退回物理线路时代。",
      significance: "minor",
    },
    {
      era: "当代",
      year: "2087",
      name: "自由体运动",
      description: "拒绝义体化的群体开始组织化，在底层获得越来越多的追随者。",
      significance: "minor",
    },
  ],

  economy: {
    currencies: [
      { name: "信用点", symbol: "Cr", description: "数字货币，由寰宇科技结算网管理" },
      { name: "硬币", description: "底层流通的物理代币，不可追踪" },
    ],
    resources: ["义体零件", "充能电池", "生物兼容液", "数据芯片"],
    tradeNotes: "底层因信号屏蔽无法使用信用点，硬币和以物易物是主要交易方式。黑市义体交易利润极高但风险致命。",
  },

  socialStructure: {
    classes: [
      { name: "企业高管", rank: 1, description: "顶层居民，享有最先进义体与医疗" },
      { name: "签约员工", rank: 2, description: "中层居民，为企业工作换取义体维护" },
      { name: "底层自由人", rank: 3, description: "无企业合同者，义体维护只能靠黑市" },
    ],
    notes: "自由体（无义体者）不属于任何阶层，在底层被视为精神领袖，在顶层被视为恐怖分子。",
  },

  tone: {
    genres: ["cyberpunk", "noir", "thriller"],
    contentRating: "mature",
    narrativeStyle: "霓虹与阴影交织的硬派叙事，对话尖锐，节奏紧凑。",
    themes: ["身体自主权", "阶层固化", "科技异化", "企业垄断"],
  },

  mechanics: {
    combatStyle: "turn-based",
    skillSystem: "义体强化树（肢体/感官/神经/武器）与软技能（骇入、交涉、潜行、维修）双轨并行。",
    difficulty: "hard",
    customRules: [
      "义体过载检定：高强度动作后骰过载值，失败触发金属热",
      "底层行动无网络支援，骇入只能通过物理接触",
      "赤焰安保巡逻有固定路线，可观察规律后规避",
    ],
  },

  startingConditions: {
    openingScenario:
      "凌晨三点，底层第七区。虹姐的加急信息把你叫醒：旧友阿灰失联48小时，最后位置信号来自第三区废弃充能站。虹姐要的是阿灰手上那批'特殊义体'数据。酬金丰厚，但第三区是赤焰安保的巡逻区。",
    playerConstraints: [
      "初始仅有民用级义体腿",
      "无企业授权，不可进入中层以上",
    ],
    startingLocation: "底层・第七区",
    startingResources: { 硬币: 200, 充能电池: 2 },
  },
};

// ── World 3: 九州・云梦泽 (zh-CN) ──────────────────────────

export const CLOUDMERE_DIMENSIONS: WorldDimensions = {
  geography: {
    overview: "九州大陆东南的广袤灵域，水汽充沛、灵气浓郁，宗门林立于灵脉之上。",
    regions: [
      {
        name: "青萍山",
        description: "青萍宗所在的灵脉山峰，山腰以下是外门，山顶是内门禁地。",
        climate: "四季如春，常有灵雾缭绕",
        landmarks: [
          { name: "试炼场", description: "年度试炼大会的比武场地。" },
          { name: "坊市", description: "外门弟子交易灵石、丹药、法器的集市。" },
        ],
      },
      {
        name: "云梦泽深处",
        description: "未经开发的原始灵域，瘴气与灵兽并存，藏有野生灵脉。",
        climate: "湿热多瘴，灵气浓度极不稳定",
        landmarks: [
          { name: "梦莲池", description: "野生梦莲的主要产地，常有人冒险采摘。" },
        ],
      },
      {
        name: "灵渡镇",
        description: "各宗门势力交汇的中立市镇，散修与宗门弟子在此交易。",
        climate: "温和湿润",
        landmarks: [
          { name: "万宝楼", description: "灵渡镇最大的拍卖行，偶有上古法器现世。" },
        ],
      },
    ],
  },

  factions: [
    {
      id: "qingping-sect",
      name: "青萍宗",
      description: "偏居一隅的中小宗门，擅水系法术与灵植培育，门风淳朴。",
      type: "guild",
      influence: "minor",
      leader: "宗主・陆沉渊（金丹后期）",
      headquarters: "青萍山",
    },
    {
      id: "tianji-pavilion",
      name: "天机阁",
      description: "云梦泽最强宗门，以炼丹术闻名天下，控制多条核心灵脉。",
      type: "guild",
      influence: "major",
      leader: "阁主・玄清子（元婴期）",
      headquarters: "天机峰",
      relations: [
        { targetId: "qingping-sect", type: "neutral", description: "未将青萍宗视为威胁" },
        { targetId: "heiyuan-sect", type: "hostile", description: "暗中争夺灵脉控制权" },
      ],
    },
    {
      id: "heiyuan-sect",
      name: "黑渊宗",
      description: "行事阴狠的宗门，修炼偏门功法，觊觎各派灵脉。",
      type: "guild",
      influence: "major",
      leader: "宗主・殷无极（金丹巅峰）",
      relations: [
        { targetId: "tianji-pavilion", type: "hostile" },
      ],
    },
    {
      id: "loose-cultivators",
      name: "散修联盟",
      description: "没有宗门背景的独立修士组成的松散互助组织。",
      type: "other",
      influence: "minor",
      headquarters: "灵渡镇",
    },
  ],

  powerSystem: {
    name: "灵气修炼",
    type: "cultivation",
    description: "吸纳天地灵气淬炼己身，以功法引导灵气在体内循环，逐步突破境界。",
    rules: [
      "修炼需功法、灵石和天赋（灵根属性决定亲和系别）",
      "灵脉附近灵气浓郁，修炼效率倍增；荒野灵气稀薄",
      "梦莲可短暂扩展灵识但有成瘾风险，长期使用损伤根基",
      "跨境界突破需机缘与资源，大多数修士终身停在练气期",
    ],
    tiers: [
      { name: "练气", rank: 1, description: "感应灵气并引入体内，分九层" },
      { name: "筑基", rank: 2, description: "灵气凝实，构建修仙根基" },
      { name: "金丹", rank: 3, description: "灵力凝结成丹，实力质变" },
      { name: "元婴", rank: 4, description: "孕育元婴分身，可御空飞行" },
      { name: "化神", rank: 5, description: "沟通天地法则，近乎传说" },
    ],
  },

  history: [
    {
      era: "上古",
      name: "灵潮涌现",
      description: "天地灵气复苏，云梦泽成为九州灵气最浓郁的区域之一。",
      significance: "major",
    },
    {
      era: "宗门纪",
      name: "百宗争脉",
      description: "数百个宗门为争夺灵脉大战，最终天机阁、黑渊宗等强宗胜出。",
      significance: "major",
    },
    {
      era: "当代",
      year: "三年前",
      name: "青萍宗灵脉衰退",
      description: "青萍山灵脉出现衰退迹象，宗门资源日趋紧张。",
      significance: "minor",
    },
    {
      era: "当代",
      year: "近日",
      name: "野生灵脉发现",
      description: "外门首席苏婉在云梦泽深处发现未登记的野生灵脉，消息尚未公开。",
      significance: "major",
    },
  ],

  economy: {
    currencies: [
      { name: "灵石", symbol: "◆", description: "兼做货币与修炼能量源，分下品/中品/上品" },
    ],
    resources: ["灵草", "丹药", "法器", "灵兽材料", "梦莲"],
    tradeNotes: "宗门坊市内部交易用灵石；灵渡镇的万宝楼是跨宗门高价值交易的主要场所。",
  },

  socialStructure: {
    classes: [
      { name: "宗门长老", rank: 1, description: "金丹期以上强者，宗门决策层" },
      { name: "内门弟子", rank: 2, description: "筑基期或天赋出众者，获重点培养" },
      { name: "外门弟子", rank: 3, description: "练气期弟子，负责杂务，通过试炼可升入内门" },
      { name: "散修", rank: 4, description: "无宗门背景的独立修士，资源匮乏" },
    ],
    notes: "修仙世界以实力为尊，境界突破可打破阶层壁垒，但低阶弟子常被当作棋子。",
  },

  tone: {
    genres: ["xianxia", "adventure", "political-intrigue"],
    contentRating: "teen",
    narrativeStyle: "古风仙侠笔触，山水灵秀中暗藏宗门权谋。",
    themes: ["弱者成长", "宗门政治", "灵脉争夺", "机缘与命运"],
  },

  mechanics: {
    combatStyle: "turn-based",
    skillSystem: "以灵根属性为基础的法术体系（水/火/木/金/土），辅以炼丹、炼器、阵法等辅助技能。",
    difficulty: "normal",
    customRules: [
      "修炼进度受灵脉浓度、功法品质和灵根资质三重影响",
      "梦莲使用需成瘾检定，连续使用增加失败概率",
      "跨境界战斗实力差距极大，通常无法正面对抗",
    ],
  },

  startingConditions: {
    openingScenario:
      "试炼大会三日后举行，你正在坊市采购备战物资。师姐苏婉匆匆赶来，说她在云梦泽深处发现了一处野生灵脉。消息若泄露，各大宗门必定争抢。她问你：大会之前，要不要先去探查？",
    playerConstraints: [
      "初始为练气三层，水灵根",
      "仅限使用青萍宗入门功法",
    ],
    startingLocation: "青萍山・坊市",
    startingResources: { "下品灵石": 30, 丹药: 3 },
  },
};

// ── World 4: Mistport Chronicles (en-US) ────────────────────

export const MISTPORT_EN_DIMENSIONS: WorldDimensions = {
  geography: {
    overview:
      "A port city wedged between sea cliffs and the ocean, shrouded in perpetual grey fog that limits visibility to fifty paces.",
    regions: [
      {
        name: "Upper City",
        description: "Seat of the Council and trade guilds, perched atop the cliffs with stone-built halls.",
        climate: "Thinner fog, occasional glimpses of sky",
        landmarks: [
          { name: "Council Hall", description: "The political nerve center, its dome set with ancient tide-stone lamps." },
          { name: "Tide-Reader Guild Tower", description: "Academy and appraisal center for ancient relics." },
        ],
      },
      {
        name: "Mid-Harbor",
        description: "Docks, workshops, and inns — the economic heart of Mistport.",
        climate: "Perpetual fog, humid and warm",
        landmarks: [
          { name: "Main Pier", description: "The only large berth; ferries and cargo ships dock here." },
          { name: "Tide-Bell Tower", description: "A tide-driven clocktower marking ebb and flow." },
        ],
      },
      {
        name: "The Undertow",
        description: "Ancient ruins exposed at low tide; the layout changes with every withdrawal.",
        climate: "Cold and briny, corrosive salt mist",
        landmarks: [
          { name: "Bone Arch", description: "A half-submerged colossal archway of unknown origin." },
        ],
      },
    ],
  },

  factions: [
    {
      id: "council",
      name: "Mistport Council",
      description: "The ruling political body of the Upper City, pushing the 'Seal Tide Decree' to restrict Undertow access.",
      type: "political",
      influence: "major",
      leader: "Councilor Chen",
      headquarters: "Upper City — Council Hall",
      relations: [
        { targetId: "salt-fangs", type: "hostile", description: "Views the Salt Fangs as an outlaw syndicate" },
      ],
    },
    {
      id: "tide-readers",
      name: "Tide-Reader Guild",
      description: "Scholars who appraise ancient relics and study tidal patterns.",
      type: "guild",
      influence: "major",
      leader: "Guildmaster Qi",
      headquarters: "Upper City — Guild Tower",
      relations: [
        { targetId: "council", type: "allied", description: "Funded by the Council, provides appraisal services" },
      ],
    },
    {
      id: "salt-fangs",
      name: "Salt Fangs",
      description: "A smuggler syndicate controlling the relic black market in the Undertow.",
      type: "criminal",
      influence: "major",
      leader: "Iron Meg",
      headquarters: "The Undertow — Hidden Grotto",
      relations: [
        { targetId: "council", type: "hostile", description: "Openly defies Council blockade policies" },
      ],
    },
  ],

  powerSystem: {
    name: "Tide-Force",
    type: "magic",
    description:
      "Unpredictable energy stored in ancient relics, resonating with tidal cycles. Tide-Readers can channel and stabilize its effects.",
    rules: [
      "Relic effects vary with tidal phase — strongest at high tide, most stable at low tide",
      "Using an unappraised relic may trigger dangerous backlash",
      "Fog beasts are drawn to Tide-Force fluctuations; large-scale relic use attracts swarms",
      "Tide-Readers channel energy through 'tide-marks' — patterns requiring years of training",
    ],
    tiers: [
      { name: "Apprentice", rank: 1, description: "Can sense whether a relic is active" },
      { name: "Tide-Reader", rank: 2, description: "Can appraise and stabilize standard relics" },
      { name: "Tide-Warden", rank: 3, description: "Can actively direct Tide-Force — exceedingly rare" },
    ],
  },

  history: [
    {
      era: "Ancient",
      name: "The Builders' Era",
      description: "The civilization that created the Undertow ruins; no written records survive, only structural remnants.",
      significance: "major",
    },
    {
      era: "Founding",
      year: "~300 years ago",
      name: "Founding of Mistport",
      description: "Refugees built walkways between the cliffs and discovered tradeable relics exposed at low tide.",
      significance: "major",
    },
    {
      era: "Modern",
      year: "Last year",
      name: "Seal Tide Decree Draft",
      description: "Councilor Chen proposed banning unlicensed civilians from the Undertow, sparking unrest in the lower tiers.",
      significance: "minor",
    },
  ],

  economy: {
    currencies: [
      { name: "Tide Coin", symbol: "₮", description: "Standard currency issued by the Council" },
      { name: "Salt Chip", description: "Untraceable token used in Salt Fangs black market" },
    ],
    resources: ["Ancient relics", "Tide salt", "Fog fungus (edible)", "Cliff iron"],
    tradeNotes:
      "The relic trade is Mistport's economic backbone. Legal relics go through Guild appraisal and auction; the black market runs through the Salt Fangs.",
  },

  socialStructure: {
    classes: [
      { name: "Councilors & Merchants", rank: 1, description: "Upper City elite controlling politics and legal trade" },
      { name: "Mid-Harbor Citizens", rank: 2, description: "Dockworkers, artisans, innkeepers — the city's backbone" },
      { name: "Undertow Dwellers", rank: 3, description: "Scavengers and smugglers living at the city's edge" },
    ],
    notes: "Tide-Reader Guild members hold cross-tier passage rights regardless of social class.",
  },

  tone: {
    genres: ["dark-fantasy", "mystery", "exploration"],
    contentRating: "teen",
    narrativeStyle:
      "Gothic suspense shrouded in fog — slow-paced on the surface, with dangerous undercurrents.",
    themes: ["class divide", "the unknown", "order vs. freedom"],
  },

  mechanics: {
    combatStyle: "narrative",
    skillSystem:
      "Skill trees by vocation: Tide-Reading (appraise/channel relics), Stealth (fog navigation), Diplomacy (social), Combat.",
    difficulty: "normal",
    customRules: [
      "Fog actions require sound/light checks — failure attracts fog beasts",
      "Relics must be appraised before use, or trigger a random-effect table",
      "Tidal cycle determines explorable range in the Undertow",
    ],
  },

  startingConditions: {
    openingScenario:
      "You step off the ferry onto Mid-Harbor's main pier. The fog is thick today. A deep tide-bell rings — signaling a rare 'deep withdrawal' that will expose deeper ruins than usual. The dock buzzes with expedition recruiters and Council officers handing out Seal Tide Decree leaflets.",
    playerConstraints: [
      "Start as a Tide-Reader apprentice or common Undertow dweller",
      "No open flames permitted in the fog",
    ],
    startingLocation: "Mid-Harbor — Main Pier",
    startingResources: { "Tide Coin": 50, "Fog Lantern": 1 },
  },
};
