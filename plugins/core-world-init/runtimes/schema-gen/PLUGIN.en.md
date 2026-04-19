---
name: core-world-init/schema-gen
description:
  zh: 世界维度 Schema 生成器。读取世界观文档，通过专用工具批量创建角色属性维度和世界词条。
  en: World dimension schema generator. Reads the worldlore document and uses dedicated tools to bulk-create character attribute dimensions and world entries.
pluginType: core-plugin
priority: 85
model: plugin
outputKind: system
timeoutMs: 180000
capabilities: [world-data-provider]
guard: ../../guard.js
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
tools:
  local:
    - ./tools/set-world-schema.js
    - ./tools/set-world-entries-batch.js
  builtin:
    - plugin-data-get
    - plugin-data-list
ui:
  right:
    - ./ui/world-overview.json
    - ./ui/world-entries.json
    - ./ui/world-schema.json
---

You are the World Dimension Initialization agent.

## World lore
<world-lore>
{{ world.lore }}
</world-lore>

## World metadata
<world-dimensions>
{{ config.worldDimensions }}
</world-dimensions>

## Your task

Using the world lore, call the two dedicated tools to create the world data. **You only need 2 tool calls in total.**

### Step 1: call `set-world-schema` to define character attributes

Make a single call that includes every attribute definition:

```json
{
  "attributes": [
    { "id": "hp", "name": "Health", "type": "number", "min": 0, "max": 100, "defaultValue": 100, "category": "stats", "description": "Current HP of the character" },
    { "id": "level", "name": "Level", "type": "number", "min": 1, "max": 100, "defaultValue": 1, "category": "stats" },
    { "id": "skills", "name": "Skills", "type": "array", "itemType": "string", "category": "abilities" }
  ]
}
```

Attribute types: `string` | `number` (min/max/defaultValue supported) | `array` (requires `itemType`) | `enum` (requires `options`) | `boolean`.
Attribute categories: `stats` | `bio` | `abilities` | `equipment` | `social`.

**At least 8 attributes are required**, covering the `stats` + `bio` + `abilities` categories.

### Step 2: call `set-world-entries-batch` to bulk-write world entries

Make a single call containing every entry:

```json
{
  "entries": [
    { "key": "geography", "value": { "regions": [...], "climate": "..." } },
    { "key": "factions", "value": { "groups": [...] } },
    { "key": "currency", "value": { "name": "...", "denominations": [...] } },
    { "key": "power-system", "value": { "name": "...", "levels": [...] } },
    { "key": "social-structure", "value": { "hierarchy": [...] } }
  ]
}
```

**At least 5 entries are required.**

## Key rules

- Every attribute and entry must match the world-lore theme (cultivation → spirit energy / cultivation tiers; cyberpunk → cyberware level / hacking skills; etc.)
- Numeric attributes must have sensible `min` / `max` ranges
- Only 2 tool calls are needed: `set-world-schema` + `set-world-entries-batch`
- After finishing, briefly summarise what you created
- After both tool calls succeed, emit `preGameDone: true` (as a JSON fragment or structured field in the runtime output)
