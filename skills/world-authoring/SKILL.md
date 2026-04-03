---
name: covel-world-authoring
description: How to create Covel RPG world packages — file-based world packages with YAML manifests, i18n lore files (WORLD.*.md), structured dimensions, and the extract-dimensions API. Use this skill whenever the user wants to create a new world, write world lore, design world-building content, add or edit world dimensions, or asks about WorldDimensions, WorldRecord, WorldPackageMeta, world packages, or the world data model. Also use when working on files in worlds/ directory or world-related types.
---

# Covel World Authoring

A Covel "world" defines the setting for an RPG session. Worlds are file-based packages (like plugins), stored in the `worlds/` directory.

## World Package Structure

```
worlds/my-world/
  world.yaml          # Manifest — metadata, i18n config, structured dimensions
  WORLD.md            # Default locale lore (fallback)
  WORLD.zh.md         # Chinese lore
  WORLD.en.md         # English lore
```

### Naming Convention

- Directory name: lowercase with hyphens (`my-world`)
- Lore files: `WORLD.md` (default), `WORLD.{lang}.md` (locale-specific)
- Language codes: `zh` → `zh-CN`, `en` → `en-US`, `ja` → `ja-JP`, `ko` → `ko-KR`
- Locale-specific files take precedence over `WORLD.md`

## world.yaml Manifest

```yaml
schemaVersion: "1.0"
id: my-world                # Lowercase, a-z0-9 and hyphens only
name:
  zh-CN: 我的世界
  en-US: My World
version: "1.0.0"
summary:
  zh-CN: 简短的世界描述
  en-US: Short world description
defaultLocale: zh-CN
supportedLocales: [zh-CN, en-US]
tags: [fantasy, adventure]

# Optional: plugins to load with this world
requiredPlugins: []
recommendedPlugins: [core-combat, core-quest]

# Optional: structured world dimensions
dimensions:
  geography:
    overview:
      zh-CN: 地理概述
      en-US: Geographic overview
    regions:
      - name:
          zh-CN: 区域名
          en-US: Region Name
        description:
          zh-CN: 区域描述
          en-US: Region description
        climate:
          zh-CN: 温带海洋性
          en-US: Temperate oceanic
  # ... other dimensions
```

### I18nText Pattern

All text fields in world.yaml support two forms:

```yaml
# Simple string (single locale)
name: 雾港

# Multi-locale object
name:
  zh-CN: 雾港
  en-US: Mistport
```

Use multi-locale objects for worlds that support multiple languages.

## World Data Model

```typescript
// Inferred from worldPackageMetaSchema (Zod)
interface WorldPackageMeta {
  schemaVersion: "1.0";
  id: string;               // ^[a-z0-9-]+$
  name: I18nText;
  version: string;
  summary: I18nText;
  defaultLocale: string;
  supportedLocales: string[];
  tags?: string[];
  requiredPlugins?: string[];
  recommendedPlugins?: string[];
  dimensions?: WorldDimensions;
}

// Stored in DataStore
interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  tags?: string[];
  packageId?: string;        // Links to world package directory name
  createdAt: string;
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
type FactionType = "political" | "guild" | "corporate" | "religious" | "criminal" | "military" | "other";
type PowerSystemType = "magic" | "technology" | "cultivation" | "psychic" | "hybrid" | "other";
type ContentRating = "all-ages" | "teen" | "mature";
type CombatStyle = "turn-based" | "real-time" | "narrative" | "none";
type DifficultyLevel = "easy" | "normal" | "hard" | "adaptive";
type I18nText = string | Record<string, string>;
```

For complete type definitions of every dimension, see `references/world-types-reference.md`.

## Writing Effective Lore (WORLD.md)

The lore file is the most important for narrative quality — it's injected directly into the LLM's system prompt.

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

## Opening Scene
{1 paragraph with sensory details. End with a choice or tension point.}
```

### Best Practices

1. **Be specific, not generic.** "雾中存在'雾兽'，它们被声音和光亮吸引" > "这里很危险"
2. **Include hard constraints.** Rules the LLM must follow
3. **Name concrete entities.** Factions, locations, characters with specific names
4. **End with tension.** The opening scene should present a choice or dilemma
5. **Keep under 2000 words.** Dense, specific lore beats verbose exposition
6. **Write for the LLM.** This is system prompt content — be instructive and factual

## World Creation Paths

| User Type | Input | Method | Format |
|-----------|-------|--------|--------|
| Developer | Full package | Create `worlds/` directory manually | YAML + Markdown |
| Creative player | Lore text | `POST /api/ai/extract-dimensions` | Markdown → YAML |
| Quick start | Concept prompt | `POST /api/ai/generate-world` | Prompt → Full world |
| Agent | Skill command | `/world-create` skill | Agent generates all files |

## Extract-Dimensions API

Players who write only WORLD.md can use the LLM to extract structured dimensions:

```
POST /api/ai/extract-dimensions
Body: { lore: string, locale?: string }
Response (SSE):
  { type: "progress", phase: "extracting" }
  { type: "progress", phase: "validating" }
  { type: "done", dimensions: WorldDimensions }
  { type: "error", message: string }
```

The extracted dimensions are validated against `worldDimensionsSchema`.

## How Lore Reaches the LLM

```
WORLD.*.md → World Package Loader → WorldRecord.lore
  → Server extracts on action → Kernel sets world context
  → core-persona context provider builds system prompt
  → Injects as "世界设定 (权威参考)" at priority 100
  → All runtimes see this context → LLM generates constrained narrative
```

## API

```
GET /worlds              # List all
GET /worlds/:id          # Get single
POST /worlds             # Create (name + description required)
PATCH /worlds/:id        # Update (all fields optional)
POST /api/ai/generate-world         # Generate from prompt (SSE)
POST /api/ai/extract-dimensions     # Extract dimensions from lore (SSE)
```

Validated with Zod schemas: `worldRecordCreateSchema`, `worldRecordUpdateSchema`, `worldPackageMetaSchema` from `@covel/shared`.

## Checklist

- [ ] World package directory exists in `worlds/`
- [ ] `world.yaml` passes `worldPackageMetaSchema` validation
- [ ] `id` is lowercase with hyphens only
- [ ] At least one `WORLD.md` or `WORLD.{lang}.md` exists
- [ ] `supportedLocales` matches available lore files
- [ ] `name` and `summary` concise and evocative
- [ ] Lore follows template, under 2000 words
- [ ] If dimensions: at least `tone` and `startingConditions` filled
- [ ] Factions have unique `id`, `relations.targetId` reference valid IDs
- [ ] Power system `tiers` ordered by `rank`
- [ ] I18nText consistent (all strings or all objects within a field)
- [ ] Lore and dimensions data are consistent (no contradictions)

## Detailed Reference

For complete type definitions of all 9 dimensions, I18nText patterns, character schema integration, and plugin dependency declarations, read:

- `references/world-types-reference.md` — Full type definitions with all fields and complete examples
