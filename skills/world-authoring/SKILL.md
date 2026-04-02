---
name: covel-world-authoring
description: How to create Covel RPG world packages — lore writing, structured dimensions (geography, factions, power systems, history, economy, social structure, tone, mechanics, starting conditions), character schemas, and seed data. Use this skill whenever the user wants to create a new world, write world lore, design world-building content, add or edit world dimensions, create seed worlds, or asks about WorldDimensions, WorldRecord, WorldPackageMeta, or the world data model. Also use when the user is working on files in apps/server/src/store/seed-worlds or world-related types.
---

# Covel World Authoring

A Covel "world" defines the setting for an RPG session. It has two data layers:

1. **Lore** (`lore` field) — Free-form markdown injected into the LLM's system prompt as authoritative reference
2. **Dimensions** (`dimensions` field) — Structured data that plugins and UI can programmatically consume

Both are optional. A world can have just lore, just dimensions, or both (recommended).

## World Data Model

```typescript
interface WorldRecord {
  id: string;                    // Auto-generated
  name: string;                  // Display name
  description: string;           // 1-2 sentence summary
  lore?: string;                 // Extended markdown for LLM
  locale?: string;               // "zh-CN" or "en-US"
  tags?: string[];               // 2-5 categorization tags
  dimensions?: WorldDimensions;  // Structured world-building data
  createdAt: string;
  updatedAt?: string;
}
```

## WorldDimensions — 9 Dimensions

All optional. Fill what makes sense for your world.

| Dimension | Key Fields | Purpose |
|-----------|-----------|---------|
| **geography** | `regions[]` (name, description, climate, landmarks) | Physical world layout |
| **factions** | `id, name, type, influence, leader, relations[]` | Organizations and politics |
| **powerSystem** | `name, type, description, rules[], tiers[]` | Magic/tech/cultivation mechanics |
| **history** | `era, year, name, significance` | Timeline events |
| **economy** | `currencies[], resources[], tradeNotes` | Currency and trade |
| **socialStructure** | `classes[], races[], notes` | Social hierarchy |
| **tone** | `genres[], contentRating, narrativeStyle, themes[]` | Narrative style |
| **mechanics** | `combatStyle, skillSystem, difficulty, customRules[]` | Gameplay rules |
| **startingConditions** | `openingScenario, playerConstraints[], startingLocation` | Session initialization |

### Type Quick Reference

```typescript
// Enum values:
type FactionType = "political" | "guild" | "corporate" | "religious" | "criminal" | "military" | "other";
type PowerSystemType = "magic" | "technology" | "cultivation" | "psychic" | "hybrid" | "other";
type ContentRating = "all-ages" | "teen" | "mature";
type CombatStyle = "turn-based" | "real-time" | "narrative" | "none";
type DifficultyLevel = "easy" | "normal" | "hard" | "adaptive";
type I18nText = string | Record<string, string>;
```

For complete type definitions of every dimension, see `references/world-types-reference.md`.

## Writing Effective Lore

The `lore` field is the most important for narrative quality — it's injected directly into the LLM's system prompt.

### Lore Template

```markdown
# {World Name}

## World Setting
{2-3 paragraphs: physical environment, key concepts, atmosphere}

## Core Rules
- {Rule 1: physics/magic/technology constraint}
- {Rule 2: social/political rule}
- {Rule 3: danger/risk rule}

## Key Characters
- {Name}: {Role}, {1-sentence description}
- {Name}: {Role}, {1-sentence description}

## Opening Scene
{1 paragraph with sensory details. End with a choice or tension point.}
```

### Best Practices

1. **Be specific, not generic.** "雾中存在'雾兽'，它们被声音和光亮吸引" > "这里很危险"
2. **Include hard constraints.** Rules the LLM must follow: "每次潮退暴露不同遗迹，永远不重复"
3. **Name concrete entities.** Factions, locations, characters with specific names
4. **End with tension.** The opening scene should present a choice or dilemma
5. **Keep under 2000 words.** Dense, specific lore beats verbose exposition
6. **Write for the LLM.** This is system prompt content — be instructive and factual

### Lore vs Dimensions

| Aspect | Lore (markdown) | Dimensions (structured) |
|--------|----------------|------------------------|
| Consumer | LLM system prompt | Plugins, UI, game mechanics |
| Format | Free-form markdown | Typed JSON objects |
| Purpose | Narrative guidance | Programmatic data |

Write lore first for narrative flavor, then extract structured dimensions for plugins.

## Dimension Examples

### Geography

```typescript
geography: {
  overview: "雾港建在悬崖与海面之间，被永恒浓雾笼罩。",
  regions: [
    {
      name: "上城",
      description: "议会与商会所在地，雾气稀薄。",
      climate: "雾气稀薄，偶见天光",
      landmarks: [{ name: "议事厅", description: "议会权力中枢" }],
    },
  ],
}
```

### Factions

```typescript
factions: [
  {
    id: "council",
    name: "雾港议会",
    description: "上城的统治机构，由商会领袖和世家组成。",
    type: "political",
    influence: "major",
    leader: "陈议长",
    headquarters: "上城・议事厅",
    relations: [{ targetId: "salt-fangs", type: "hostile" }],
  },
]
```

### Power System

```typescript
powerSystem: {
  name: "灵气修炼",
  type: "cultivation",
  description: "以灵根为基础，吸收天地灵气进行修炼。",
  rules: ["灵气并非均匀分布", "修炼需要功法、灵石和天赋"],
  tiers: [
    { name: "练气", rank: 1 },
    { name: "筑基", rank: 2 },
    { name: "金丹", rank: 3 },
  ],
}
```

### Tone & Starting Conditions

```typescript
tone: {
  genres: ["dark-fantasy", "mystery"],
  contentRating: "teen",
  narrativeStyle: "哥特悬疑风格，节奏缓慢但暗流涌动。",
  themes: ["阶层对立", "未知探索"],
}

startingConditions: {
  openingScenario: "你刚抵达雾港中港的主栈桥。浓雾中传来潮汐钟声。",
  playerConstraints: ["初始为验潮师学徒"],
  startingLocation: "中港・主栈桥",
  startingResources: { "潮币": 50, "雾灯": 1 },
}
```

## How Lore Reaches the LLM

```
WorldRecord.lore → Server extracts on action → Kernel sets world context
  → core-persona context provider builds system prompt
  → Injects as "世界设定 (权威参考)" at priority 100
  → All runtimes see this context → LLM generates constrained narrative
```

Narration style auto-detected from world name/description keywords:
- 江湖/武侠 → Wuxia style | 赛博/义体 → Cyberpunk | 修仙/灵气 → Xianxia | 港/雾 → Harbor mood

## API

```
GET /worlds              # List all
GET /worlds/:id          # Get single
POST /worlds             # Create (name + description required)
PATCH /worlds/:id        # Update (all fields optional)
```

Validated with Zod schemas: `worldRecordCreateSchema`, `worldRecordUpdateSchema` from `@covel/shared`.

## Seed World Pattern

```typescript
// apps/server/src/store/seed-world-dimensions.ts
import type { WorldDimensions } from "@covel/shared";
export const MY_WORLD_DIMENSIONS: WorldDimensions = { ... };

// apps/server/src/store/seed-worlds.ts
import type { WorldDimensions } from "@covel/shared";
export interface SeedWorld {
  name: string; description: string; lore: string;
  locale: "zh-CN" | "en-US"; tags: string[]; dimensions?: WorldDimensions;
}
```

See `apps/server/src/store/seed-world-dimensions.ts` for 4 complete examples.

## Checklist

- [ ] `name` and `description` concise and evocative
- [ ] `lore` follows template (Setting, Rules, Characters, Opening), under 2000 words
- [ ] `locale` set correctly
- [ ] `tags` are 2-5 short keywords
- [ ] If dimensions: at least `tone` and `startingConditions` filled
- [ ] Factions have unique `id`, `relations.targetId` reference valid IDs
- [ ] Power system `tiers` ordered by `rank`
- [ ] Economy has at least 1 currency
- [ ] I18nText consistent (all strings or all objects)
- [ ] Lore and dimensions data are consistent (no contradictions)

## Detailed Reference

For complete type definitions of all 9 dimensions, I18nText patterns, character schema integration, and plugin dependency declarations, read:

- `references/world-types-reference.md` — Full type definitions with all fields and complete examples
