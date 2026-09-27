# world.yaml Schema Reference

Use the current strict `worldManifestSchema` in `packages/shared/src/schemas/world.ts`. Display text accepts I18nText; provide bilingual display names/labels when publishing in this repository.

Required fields are `schemaVersion` (string), `id` (kebab-case), `name`, `summary`, and `defaultLocale`. Optional fields are `version`, `supportedLocales`, `tags`, `pluginPolicy`, `pluginSettings`, `worldData`, `characterSchema`, `defaultViewMode`, `dimensions`, and `dimensionSources`.

## Plugin selection

```yaml
pluginPolicy:
  presetId: traditional-story
  preferredTags: [mode:traditional-story]
  avoidedTags: [mode:dialogue]
  requested: [dice-check, inventory]
  recommended: [guide]
```

The host resolves requested plugins and their public dependency contracts. Check the actual installed catalogue and resolver diagnostics; tags alone are not dependency contracts. Do not declare removed top-level required/recommended/excluded plugin arrays. Presets and packs are catalogue data, not a reason for framework code to branch on concrete plugin IDs.

## Character domain schema

```yaml
characterSchema:
  types: [npc, companion]
  attributes:
    - id: resolve
      name: {zh: 意志, en: Resolve}
      type: number
      category: stats
      min: 0
      max: 5
      defaultValue: 2
```

`player` is the reserved singleton type; additional types are declared here. `attributes` uses the host's attribute-definition schema. The session World Model stores schema and characters directly. Do not mirror characters into a plugin namespace or use removed blueprint-source root fields.

## World data contracts

`worldData: data/world.data.yaml` imports structured content. For public plugin data, use versioned contracts:

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions
  characters:
    kind: json
    path: characters/characters.json
    to: characters
    key: id
  memory:
    kind: json
    path: data/memory-blocks.json
    schema: contract:memory.blocks@1
    to: contract:memory.blocks@1
    key: id
```

Memory data is one object `{ "id": "world", "blocks": [...] }`; each block supplies `label`, `displayName`, and `extractionHint`, with optional `icon` and `maxChars`. Do not put memory policy in `world.yaml`.

Other data contracts include `character.blueprints@1`, `world.rules@1`, `quests@1`, `inventory.items@1`, `character.affinity@1`, `character.portraits@1`, and `stage.scenes@1`. Verify the chosen provider's actual `contracts` and `contributes.data.accepts` declarations and validate every record against that schema. Use `to: contract:<id>` or `to: contract:<id>+lorebook` for an authorized projection. Media indexes use `indexTo: contract:<id>` (for example `character.portrait-assets@1`), with a separate matching presence source. Removed `plugin:`/`plugin://` destinations are not accepted.

Domain destinations remain `characters`, `lorebook`, `media`, and `world:metadata.<path>`. Keep paths package-relative. Validate descriptor schemas, references between sources, and content records; validating `world.yaml` alone does not validate imported values.

## dimensions.geography

```yaml
geography:
  overview: <I18nText> # 可选
  regions: # 必需，至少 1 个
    - name: <I18nText> # 必需
      description: <I18nText> # 必需
      climate: <I18nText> # 必需
      landmarks: # 可选
        - name: <I18nText>
          description: <I18nText> # 可选
```

## dimensions.factions

```yaml
factions: # 数组
  - id: <kebab-case> # 必需，正则 ^[a-z][a-z0-9-]*$
    name: <I18nText> # 必需
    description: <I18nText> # 必需
    type: <enum> # 必需：political|guild|corporate|religious|criminal|military|other
    influence: <enum> # 必需：major|minor
    leader: <I18nText> # 可选
    headquarters: <I18nText> # 可选
    relations: # 可选
      - type: <string> # 如 hostile|neutral|allied
        targetId: <string> # 其他 faction 的 id
        description: <I18nText> # 可选
```

## dimensions.powerSystem

```yaml
powerSystem:
  name: <I18nText> # 必需
  type: <enum> # 必需：magic|technology|cultivation|psychic|hybrid|other
  description: <I18nText> # 必需
  rules: # 必需，至少 1 条，每条为 I18nText
    - <I18nText>
  tiers: # 可选
    - name: <I18nText>
      rank: <int, ≥1> # 必需
      description: <I18nText> # 可选
```

## dimensions.history

```yaml
history: # 数组
  - name: <I18nText> # 必需
    description: <I18nText> # 必需
    significance: <enum> # 必需：major|minor
    era: <I18nText> # 可选
    year: <I18nText> # 可选
```

## dimensions.economy

```yaml
economy:
  currencies: # 必需，至少 1 个
    - name: <I18nText> # 必需
      symbol: <string> # 可选
      description: <I18nText> # 可选
  resources: # 可选，I18nText 数组
    - <I18nText>
  tradeNotes: <I18nText> # 可选
```

## dimensions.socialStructure

```yaml
socialStructure:
  classes: # 可选
    - name: <I18nText> # 必需
      description: <I18nText> # 必需
      rank: <int> # 可选
  races: # 可选
    - name: <I18nText>
      description: <I18nText>
      traits: [<I18nText>] # 可选
  notes: <I18nText> # 可选
```

## dimensions.tone

```yaml
tone:
  genres: # 必需，至少 1 个，I18nText 数组
    - <I18nText>
  contentRating: <enum> # 必需：all-ages|teen|mature
  narrativeStyle: <I18nText> # 可选
  themes: # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.mechanics

```yaml
mechanics:
  combatStyle: <enum> # 可选：turn-based|real-time|narrative|none
  difficulty: <enum> # 可选：easy|normal|hard|adaptive
  skillSystem: <I18nText> # 可选
  customRules: # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.startingConditions

```yaml
startingConditions:
  openingScenario: <I18nText> # 必需，2-3 句呈现即时紧张感
  startingLocation: <I18nText> # 可选
  playerConstraints: # 可选，I18nText 数组
    - <I18nText>
  startingResources: # 可选，Record<string, number>
    <资源名>: <数量>
  openingHook: <I18nText> # 可选，开场短钩子
  openingChips: # 可选，开场快捷行动建议
    - <I18nText>
```

## 文件结构

```
worlds/<id>/
├── world.yaml            # 必需
├── WORLD.md              # 必需，默认 lore（所有 locale 的兜底）
├── WORLD.<lang>.md       # 可选，某个 locale 的覆盖版本
├── data/
│   ├── world.data.yaml   # worldData descriptor（推荐）
│   ├── dimensions.yaml   # 外置维度（两个内置世界的做法）
│   └── rules/            # living-world-rules 规则包
├── characters/           # 角色蓝图 JSON
└── media/                # 立绘 / 场景背景 + 索引 JSON
```

lore 解析链 **`WORLD.<lang>.md` → `WORLD.md` → 空字符串**（`apps/server/src/world-seed-loader.ts`）。`WORLD.md` 缺了会让所有没有对应 `WORLD.<lang>.md` 的 locale 拿到空 lore；`pnpm release:preflight` 只检查"至少有一个 `WORLD*.md`"，兜不住这个坑。
