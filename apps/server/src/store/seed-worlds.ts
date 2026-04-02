/**
 * Preset seed worlds for out-of-the-box gameplay.
 */
import type { WorldDimensions } from "@covel/shared";
import {
  MISTPORT_DIMENSIONS,
  NEONRIDGE_DIMENSIONS,
  CLOUDMERE_DIMENSIONS,
  MISTPORT_EN_DIMENSIONS,
} from "./seed-world-dimensions.js";

export interface SeedWorld {
  name: string;
  description: string;
  /** Extended lore injected into system prompt as world context. */
  lore: string;
  locale: "zh-CN" | "en-US";
  tags: string[];
  /** Structured world-building dimensions. */
  dimensions?: WorldDimensions;
}

export const SEED_WORLDS: SeedWorld[] = [
  {
    name: "雾港・裂潮纪",
    description: "一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。",
    locale: "zh-CN",
    tags: ["港", "雾", "冒险"],
    dimensions: MISTPORT_DIMENSIONS,
    lore: `# 雾港・裂潮纪

## 世界设定
雾港是一座建在悬崖与海面之间的港口城市。永恒的灰白浓雾笼罩一切，能见度从不超过五十步。
城市分为三层：上城（议会与商会）、中港（码头与工坊）、下潮区（潮汐暴露的远古遗迹）。

## 核心规则
- 每次潮退，下潮区会暴露出不同的远古建筑遗迹，永远不会重复。
- 雾中存在"雾兽"，它们被声音和光亮吸引。大声喧哗或明火在雾中是致命行为。
- 远古遗物具有不可预测的效果，需经"验潮师"鉴定后才可安全使用。
- 议会控制上城，走私帮派"盐牙会"控制下潮区的遗物交易。

## 关键人物
- 林远舟：验潮师公会的年轻学徒，刚通过初试。（可作为玩家角色）
- 铁姑：盐牙会的二当家，掌控黑市遗物流通。
- 陈议长：议会主席，推行"封潮令"禁止平民进入下潮区。

## 开局情境
玩家刚抵达雾港中港的栈桥。浓雾中传来低沉的潮汐钟声——这意味着一次罕见的"深退潮"即将发生，下潮区会暴露出更深层的遗迹。
码头上人声鼎沸：有人在招募深潮探险队，也有人在散发议会的"封潮令"传单。`,
  },
  {
    name: "霓虹脊・2087",
    description: "赛博朋克城市，义体改造与企业战争是日常。你是街头的无名小卒。",
    locale: "zh-CN",
    tags: ["赛博", "义体", "霓虹"],
    dimensions: NEONRIDGE_DIMENSIONS,
    lore: `# 霓虹脊・2087

## 世界设定
霓虹脊是一座垂直发展的巨型城市。底层是永夜的贫民窟，顶层是企业集团的空中庭园。
义体改造（cybernetics）是日常，超过70%的居民至少有一处义体。但义体需要定期维护和充能，这成了底层人的经济枷锁。

## 核心规则
- 义体过载会导致"金属热"——身体排异反应，轻则抽搐，重则义体失控。
- 底层区域信号被屏蔽，无法连接城市主网。通讯依赖物理线路和跑腿信使。
- 三大企业集团（寰宇科技、赤焰安保、幽蓝制药）各控制城市的不同系统。
- "自由体"（完全无义体者）是稀有群体，被底层人崇拜，被企业视为安全威胁。

## 关键人物
- 玩家：外号"线虫"，底层的跑腿信使，靠一双义体腿谋生。
- 阿灰：旧友，黑市义体技师，最近接了一个"大活"后失联。
- 虹姐：底层"信号站"的老板，掌控底层的信息网络。

## 开局情境
凌晨三点，底层第七区。玩家被虹姐的加急信息叫醒：阿灰已经失联48小时，最后的位置信号来自第三区的废弃充能站。
虹姐说她不在乎阿灰的死活，但阿灰手上有一批"特殊义体"的数据，那才是她要的东西。
酬金丰厚，但第三区现在是赤焰安保的巡逻区。`,
  },
  {
    name: "九州・云梦泽",
    description: "修仙世界，灵气复苏，宗门林立。你是偏僻小宗的外门弟子。",
    locale: "zh-CN",
    tags: ["修仙", "灵气", "宗门"],
    dimensions: CLOUDMERE_DIMENSIONS,
    lore: `# 九州・云梦泽

## 世界设定
云梦泽是九州大陆东南的一片灵域，水汽充沛，灵气浓郁。这里宗门林立，以灵植、炼丹和水系法术闻名。
修仙体系分为：练气、筑基、金丹、元婴、化神五个大境界。大多数修士终身停在练气期。

## 核心规则
- 灵气并非均匀分布，灵脉附近浓郁，荒野稀薄。宗门都建在灵脉之上。
- 修炼需要功法、灵石（货币兼能量源）和天赋（灵根属性）。
- 云梦泽特产"梦莲"，服用后可进入短暂的灵识扩展状态，但有成瘾风险。
- 宗门之间表面和睦，暗中争夺灵脉控制权。低阶弟子常被卷入宗门纷争充当棋子。

## 关键人物
- 玩家：青萍宗外门弟子，练气三层，水灵根，入门两年。
- 师姐苏婉：筑基期，外门首席，对玩家颇为照顾。
- 宗主陆沉渊：金丹后期，为人低调，很少露面。有传言说他在闭关冲击元婴。

## 开局情境
青萍宗一年一度的"试炼大会"将在三日后举行。外门弟子可借此机会争夺内门名额。
玩家正在坊市采购备战物资时，师姐苏婉匆匆找来，说她在云梦泽深处发现了一处未登记的野生灵脉——如果消息泄露，各大宗门必定争抢。
她问玩家：在试炼大会之前，要不要先去探查那处灵脉？`,
  },
  {
    name: "Mistport Chronicles",
    description: "A fog-shrouded port city where each tide reveals ancient ruins. Adventure awaits.",
    locale: "en-US",
    tags: ["fog", "harbor", "adventure"],
    dimensions: MISTPORT_EN_DIMENSIONS,
    lore: `# Mistport Chronicles

## World Setting
Mistport is a vertical city wedged between sea cliffs and the ocean. Perpetual grey fog limits visibility to fifty paces.
The city has three tiers: Upper City (Council and guilds), Mid-Harbor (docks and workshops), and the Undertow (ancient ruins exposed by tides).

## Core Rules
- Each low tide reveals different ancient structures in the Undertow — never the same layout twice.
- "Fog beasts" lurk in the mist, drawn to sound and light. Open flames and loud noises are lethal.
- Ancient relics have unpredictable effects and must be appraised by a licensed Tide-Reader before safe use.
- The Council controls the Upper City; the smuggler syndicate "Salt Fangs" runs the relic black market.

## Key Characters
- Player: A newly certified Tide-Reader apprentice arriving at Mid-Harbor.
- Iron Meg: Second-in-command of the Salt Fangs, controls the relic trade.
- Councilor Chen: Pushing the "Seal Tide Decree" to ban civilians from the Undertow.

## Opening Scene
You step off the ferry onto Mid-Harbor's main pier. The fog is thick today. A deep tide-bell rings — signaling a rare "deep withdrawal" that will expose deeper ruins than usual.
The dock buzzes: recruiters are forming deep-tide expedition teams, while Council officers distribute "Seal Tide Decree" leaflets.`,
  },
];
