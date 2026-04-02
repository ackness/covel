# World Types Reference

Complete type definitions, Zod schemas, I18nText patterns, and full examples for all 9 WorldDimensions.

## Table of Contents

1. [I18nText Pattern](#i18ntext-pattern)
2. [WorldRecord](#worldrecord)
3. [WorldDimensions Composite](#worlddimensions-composite)
4. [Geography](#1-geography)
5. [Factions](#2-factions)
6. [Power System](#3-power-system)
7. [History](#4-history)
8. [Economy](#5-economy)
9. [Social Structure](#6-social-structure)
10. [Tone](#7-tone)
11. [Mechanics](#8-mechanics)
12. [Starting Conditions](#9-starting-conditions)
13. [Zod Validation Schemas](#zod-validation-schemas)
14. [WorldPackageMeta](#worldpackagemeta)
15. [Character Schema Integration](#character-schema-integration)
16. [Plugin Dependency Declarations](#plugin-dependency-declarations)
17. [Complete World Example](#complete-world-example)

---

## I18nText Pattern

All display text uses `I18nText` for localization:

```typescript
// Locale-aware text: plain string = default locale only, object = locale map
type I18nText = string | Record<string, string>;

// Usage patterns:
const simple: I18nText = "雾港";                       // Single locale
const multi: I18nText = { "zh-CN": "雾港", "en-US": "Mistport" };  // Multi-locale

// Reading in handlers:
const isZh = ctx.locale.startsWith("zh");
const text = typeof name === "string" ? name : (name[ctx.locale] ?? name["zh-CN"]);
```

**Rule**: Within a single world, be consistent. Either all `I18nText` fields are strings (single locale) or all are `Record<string, string>` (multi-locale). Don't mix.

---

## WorldRecord

The runtime representation of a world. Stored in memory-store / DB.

```typescript
interface WorldRecord {
  id: string;                    // Auto-generated UUID
  name: string;                  // Display name
  description: string;           // 1-2 sentence summary
  lore?: string;                 // Extended markdown for LLM system prompt
  locale?: string;               // "zh-CN" or "en-US"
  tags?: string[];               // 2-5 categorization tags
  dimensions?: WorldDimensions;  // Structured world-building data
  createdAt: string;             // ISO timestamp
  updatedAt?: string;            // ISO timestamp
}
```

### API Boundary Types

```typescript
// POST /worlds
type WorldRecordCreate = {
  name: string;           // Required, min 1 char
  description: string;    // Required, min 1 char
  lore?: string;
  locale?: string;
  tags?: string[];
  dimensions?: WorldDimensions;
};

// PATCH /worlds/:id
type WorldRecordUpdate = Partial<WorldRecordCreate>;
```

---

## WorldDimensions Composite

All fields optional. Fill what makes sense for your world.

```typescript
interface WorldDimensions {
  geography?: WorldGeography;
  factions?: WorldFaction[];
  powerSystem?: WorldPowerSystem;
  history?: WorldHistoryEvent[];
  economy?: WorldEconomy;
  socialStructure?: WorldSocialStructure;
  tone?: WorldTone;
  mechanics?: WorldMechanics;
  startingConditions?: WorldStartingConditions;
}
```

---

## 1. Geography

```typescript
interface WorldLandmark {
  name: I18nText;
  description?: I18nText;
}

interface WorldRegion {
  name: I18nText;              // Required
  description: I18nText;       // Required
  climate?: string;
  landmarks?: WorldLandmark[];
}

interface WorldGeography {
  overview?: I18nText;         // 1-2 sentence world geography summary
  regions: WorldRegion[];      // At least 1 region required (Zod: min 1)
}
```

### Example

```typescript
geography: {
  overview: "悬崖与海面之间的港口城市，永恒灰白浓雾笼罩。",
  regions: [
    {
      name: "上城",
      description: "议会与商会所在地，位于悬崖顶部。",
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
        { name: "主栈桥", description: "雾港唯一的大型泊位。" },
      ],
    },
  ],
}
```

---

## 2. Factions

```typescript
type FactionType = "political" | "guild" | "corporate" | "religious" | "criminal" | "military" | "other";
type InfluenceLevel = "major" | "minor";

interface FactionRelation {
  targetId: string;                                    // Must reference another faction's id
  type: "allied" | "neutral" | "hostile" | "vassal";
  description?: I18nText;
}

interface WorldFaction {
  id: string;                   // Unique within the world (e.g. "council", "salt-fangs")
  name: I18nText;               // Required
  description: I18nText;        // Required
  type: FactionType;            // Required
  influence: InfluenceLevel;    // Required
  leader?: I18nText;
  headquarters?: string;
  relations?: FactionRelation[];
}
```

### Example

```typescript
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
      { targetId: "tide-readers", type: "allied" },
    ],
  },
  {
    id: "salt-fangs",
    name: "盐牙会",
    description: "控制下潮区遗物黑市的走私帮派。",
    type: "criminal",
    influence: "major",
    leader: "铁姑",
    headquarters: "下潮区・隐潮窟",
    relations: [
      { targetId: "council", type: "hostile" },
    ],
  },
]
```

**Checklist**: Every `relations[].targetId` must reference a valid `id` in the factions array.

---

## 3. Power System

```typescript
type PowerSystemType = "magic" | "technology" | "cultivation" | "psychic" | "hybrid" | "other";

interface PowerTier {
  name: I18nText;
  rank: number;             // Integer >= 0, lower rank = lower power
  description?: I18nText;
}

interface WorldPowerSystem {
  name: I18nText;           // Required — system name
  type: PowerSystemType;    // Required
  description: I18nText;    // Required — how it works
  rules: I18nText[];        // At least 1 rule required (Zod: min 1)
  tiers?: PowerTier[];      // Ordered by rank (ascending)
}
```

### Example

```typescript
powerSystem: {
  name: "潮力",
  type: "other",
  description: "源自海底远古遗迹的神秘力量，通过潮汐传导。",
  rules: [
    "潮力在退潮时最强，涨潮时几乎无法使用",
    "使用潮力需要'潮石'作为媒介",
    "过度使用潮力会导致'雾蚀'——身体逐渐透明化",
  ],
  tiers: [
    { name: "感潮", rank: 1, description: "能感知潮汐变化" },
    { name: "引潮", rank: 2, description: "能引导小规模潮力" },
    { name: "驭潮", rank: 3, description: "能操控潮力进行战斗或探索" },
    { name: "裂潮", rank: 4, description: "传说中的境界，可撕裂潮汐屏障" },
  ],
}
```

---

## 4. History

```typescript
type HistorySignificance = "major" | "minor";

interface WorldHistoryEvent {
  era?: string;
  year?: string;
  name: I18nText;               // Required
  description: I18nText;        // Required
  significance: HistorySignificance;  // Required
}
```

### Example

```typescript
history: [
  {
    era: "远古",
    name: "大潮灭世",
    description: "传说中一场席卷大陆的超级潮汐，摧毁了先民文明。",
    significance: "major",
  },
  {
    era: "裂潮纪",
    year: "裂潮历 247 年",
    name: "雾港建城",
    description: "流民在悬崖与海面之间发现了远古遗迹的庇护，开始定居。",
    significance: "major",
  },
  {
    year: "裂潮历 312 年",
    name: "封潮令",
    description: "议会颁布法令，限制平民进入下潮区以'保护公共安全'。",
    significance: "major",
  },
]
```

---

## 5. Economy

```typescript
interface WorldCurrency {
  name: I18nText;         // Required
  symbol?: string;
  description?: I18nText;
}

interface WorldEconomy {
  currencies: WorldCurrency[];    // At least 1 required (Zod: min 1)
  resources?: I18nText[];
  tradeNotes?: I18nText;
}
```

### Example

```typescript
economy: {
  currencies: [
    { name: "潮币", symbol: "⚓", description: "雾港通用货币，由议会铸造。" },
    { name: "潮石碎片", description: "非正式交换物，在黑市流通。" },
  ],
  resources: ["远古遗物", "潮石", "雾鱼", "盐晶"],
  tradeNotes: "下潮区遗物交易由盐牙会垄断，上城商会控制合法渠道。",
}
```

---

## 6. Social Structure

```typescript
interface SocialClass {
  name: I18nText;          // Required
  description?: I18nText;
  rank?: number;           // Integer, higher = higher social status
}

interface WorldRace {
  name: I18nText;          // Required
  description?: I18nText;
  traits?: I18nText[];
}

interface WorldSocialStructure {
  classes?: SocialClass[];
  races?: WorldRace[];
  notes?: I18nText;
}
```

### Example

```typescript
socialStructure: {
  classes: [
    { name: "议员世家", rank: 3, description: "上城统治阶层，垄断潮石贸易特许权。" },
    { name: "验潮师", rank: 2, description: "受尊重的学者阶层，负责遗物鉴定。" },
    { name: "港民", rank: 1, description: "普通居民，多在中港务工。" },
    { name: "潮下人", rank: 0, description: "生活在下潮区边缘的拾荒者。" },
  ],
  notes: "阶层流动近乎停滞，除非获得验潮师公会的推荐。",
}
```

---

## 7. Tone

```typescript
type ContentRating = "all-ages" | "teen" | "mature";

interface WorldTone {
  genres: string[];                // At least 1 required (Zod: min 1). Free-form: "dark-fantasy", "mystery", "wuxia", etc.
  contentRating: ContentRating;    // Required
  narrativeStyle?: I18nText;       // Describes the writing voice
  themes?: string[];               // Core thematic elements
}
```

### Example

```typescript
tone: {
  genres: ["dark-fantasy", "mystery", "exploration"],
  contentRating: "teen",
  narrativeStyle: "哥特悬疑风格，节奏缓慢但暗流涌动。以雾气、潮汐和回声渲染氛围。",
  themes: ["阶层对立", "未知探索", "权力与知识的垄断"],
}
```

---

## 8. Mechanics

```typescript
type CombatStyle = "turn-based" | "real-time" | "narrative" | "none";
type DifficultyLevel = "easy" | "normal" | "hard" | "adaptive";

interface WorldMechanics {
  combatStyle?: CombatStyle;
  skillSystem?: I18nText;
  difficulty?: DifficultyLevel;
  customRules?: I18nText[];
}
```

### Example

```typescript
mechanics: {
  combatStyle: "narrative",
  skillSystem: "基于验潮师等级的技能解锁体系，高等级可使用更多潮力技能。",
  difficulty: "normal",
  customRules: [
    "退潮期间潮力技能伤害+50%，涨潮期间不可用",
    "雾兽战斗中，发出声音或光亮会吸引更多敌人",
  ],
}
```

---

## 9. Starting Conditions

```typescript
interface WorldStartingConditions {
  openingScenario: I18nText;               // Required — first thing the player sees
  playerConstraints?: I18nText[];          // Character creation restrictions
  startingLocation?: string;
  startingResources?: Record<string, number>;  // Item name → quantity
}
```

### Example

```typescript
startingConditions: {
  openingScenario: "你刚抵达雾港中港的主栈桥。浓雾中传来潮汐钟声，脚下的木板嘎吱作响。一个戴着验潮师铜章的老人向你走来。",
  playerConstraints: ["初始为验潮师学徒", "不能离开雾港"],
  startingLocation: "中港・主栈桥",
  startingResources: { "潮币": 50, "雾灯": 1, "学徒手册": 1 },
}
```

---

## Zod Validation Schemas

API boundary validation uses Zod. Schemas are exported from `@covel/shared`.

```typescript
import {
  worldDimensionsSchema,
  worldRecordCreateSchema,
  worldRecordUpdateSchema,
} from "@covel/shared";

// Validate creation input
const result = worldRecordCreateSchema.safeParse(userInput);
if (!result.success) {
  // result.error.issues contains validation details
}

// Validate dimension data
const dimResult = worldDimensionsSchema.safeParse(dimensionData);

// Inferred types
import type { WorldRecordCreate, WorldRecordUpdate } from "@covel/shared";
```

### Validation Rules Summary

| Field | Constraint |
|-------|-----------|
| `name` | `string().min(1)` |
| `description` | `string().min(1)` |
| `geography.regions` | `array().min(1)` |
| `factions[].id` | `string().min(1)` |
| `powerSystem.rules` | `array(i18nText).min(1)` |
| `economy.currencies` | `array().min(1)` |
| `tone.genres` | `array(string().min(1)).min(1)` |
| `startingConditions.openingScenario` | `i18nText` (required) |
| `powerTier.rank` | `number().int().min(0)` |

---

## WorldPackageMeta

The full world package format (for distribution/packaging):

```typescript
interface WorldPackageMeta {
  schemaVersion: string;
  id: string;
  name: I18nText;
  version: string;
  summary: I18nText;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  characterSchema?: unknown;            // JSON Schema for character creation fields
  requiredPlugins?: string[];           // Plugin IDs that must be active
  recommendedPlugins?: string[];        // Plugin IDs suggested for this world
  contentVariants: WorldContentVariant[];
  dimensions?: WorldDimensions;
}

interface WorldContentVariant {
  locale: Locale;
  path: string;      // Path to markdown lore file, relative to world package root
}
```

---

## Character Schema Integration

Worlds can declare a `characterSchema` that defines the character creation fields. This is a JSON Schema consumed by the init-wizard plugin.

```typescript
// In WorldPackageMeta:
characterSchema: {
  type: "object",
  properties: {
    name: { type: "string", description: "角色名" },
    class: {
      type: "string",
      enum: ["验潮师学徒", "港民渔夫", "盐牙会线人"],
      description: "职业",
    },
    background: { type: "string", description: "背景故事" },
  },
  required: ["name", "class"],
}
```

The init-wizard plugin reads this schema and generates a dynamic character creation form.

---

## Plugin Dependency Declarations

Worlds can declare which plugins are required or recommended:

```typescript
// In WorldPackageMeta:
requiredPlugins: ["core-narrator", "core-persona"],
recommendedPlugins: ["core-combat", "core-inventory", "core-quest"],
```

- **requiredPlugins**: Must be active for the world to function. Session setup enforces this.
- **recommendedPlugins**: Suggested for best experience. UI shows these as recommended.

---

## Complete World Example

A full seed world with all 9 dimensions (condensed for reference):

```typescript
import type { WorldDimensions } from "@covel/shared";

export const MY_WORLD_DIMENSIONS: WorldDimensions = {
  geography: {
    overview: "三座浮空岛屿，以光桥相连。",
    regions: [
      {
        name: "中枢岛",
        description: "行政与商业中心。",
        climate: "终年阳光，温暖干燥",
        landmarks: [{ name: "天枢塔", description: "总督府所在地。" }],
      },
    ],
  },

  factions: [
    {
      id: "skyguard",
      name: "天卫",
      description: "守护浮空岛的军事力量。",
      type: "military",
      influence: "major",
      leader: "卫长・林铁心",
      relations: [],
    },
  ],

  powerSystem: {
    name: "光纹",
    type: "magic",
    description: "刻印在皮肤上的发光纹路，是使用光桥和光器的前提。",
    rules: ["光纹越多，消耗越大", "过载会导致失明"],
    tiers: [
      { name: "初纹", rank: 1 },
      { name: "盛纹", rank: 2 },
      { name: "满纹", rank: 3 },
    ],
  },

  history: [
    {
      era: "升空纪",
      name: "大升空",
      description: "先民将三座山峰升入天空，建立浮空文明。",
      significance: "major",
    },
  ],

  economy: {
    currencies: [{ name: "光晶", symbol: "◇" }],
    resources: ["光石", "云铁", "风丝"],
    tradeNotes: "岛际贸易依赖光桥，光桥关闭时贸易中断。",
  },

  socialStructure: {
    classes: [
      { name: "光纹师", rank: 2, description: "拥有光纹的特权阶层。" },
      { name: "无纹者", rank: 1, description: "没有光纹的平民。" },
    ],
    notes: "光纹是天生的，无法后天获得。社会流动几乎不存在。",
  },

  tone: {
    genres: ["high-fantasy", "social-drama"],
    contentRating: "teen",
    narrativeStyle: "明亮而忧伤的基调，探索特权与公正。",
    themes: ["天生特权", "社会公正", "技术垄断"],
  },

  mechanics: {
    combatStyle: "turn-based",
    skillSystem: "基于光纹等级的技能树。",
    difficulty: "normal",
    customRules: [
      "光纹使用有每日上限，超过触发过载",
      "无纹者只能使用物理攻击和道具",
    ],
  },

  startingConditions: {
    openingScenario: "你站在中枢岛的入口光桥上。桥面的光纹与你手臂上的初纹共鸣，发出微弱的光芒。",
    playerConstraints: ["初纹光纹师", "刚从边缘岛被调至中枢"],
    startingLocation: "中枢岛・入口光桥",
    startingResources: { "光晶": 30, "初级光器": 1 },
  },
};

// Seed world entry:
export interface SeedWorld {
  name: string;
  description: string;
  lore: string;
  locale: "zh-CN" | "en-US";
  tags: string[];
  dimensions?: WorldDimensions;
}

export const myWorld: SeedWorld = {
  name: "浮空三岛",
  description: "三座浮空岛屿上的光纹文明，探索特权与公正的故事。",
  lore: `# 浮空三岛\n\n## 世界设定\n...`,
  locale: "zh-CN",
  tags: ["high-fantasy", "social-drama", "floating-islands"],
  dimensions: MY_WORLD_DIMENSIONS,
};
```
