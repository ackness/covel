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

## dimensions（开放定义）

`dimensions` 是作者自定义 ID 的开放 map，不再是九类固定键。每项都是一份完整 definition，权威说明见 `docs/reference/world-data.md`「动态世界维度」：

```yaml
dimensions:
  <id>: # 正则 ^[a-z][a-zA-Z0-9_-]{0,63}$
    name: <I18nText> # 必需
    description: <I18nText> # 可选
    schema: <JSON Schema 子集> # 必需；未支持的关键字直接报错
    initialValue: <JSON> # 必需，必须通过 schema 校验
    updateRule: <I18nText> # 可选；非空时 dimension-tracker 每回合按规则结算
```

- **静态设定**（地理、阵营、力量体系、历史等）：不写 `updateRule`，只作为当前值注入叙事，不产生额外模型调用。`geography` / `factions` / `powerSystem` / `history` / `economy` / `socialStructure` / `tone` / `mechanics` / `startingConditions` 仍是推荐的内容分类，但只是 ID 惯例，不是白名单。它们的完整 schema 直接参考 `worlds/mistport/data/dimensions.yaml`。
- **演化数据**（金钱、声望、城墙耐久、图鉴）：写 `updateRule`，用自然语言说明何时、如何变化。规则只计本轮叙事中明确发生的事实；类型和范围由 schema 在提交时校验。
- 文本字段需要多语言时在 schema 节点上标 `x-i18n: true`，值写成 `{zh-CN: ..., en-US: ...}`；没有 `x-i18n` 的对象不会被当作翻译。
- 标量 = 单例；`type: array` + object `items` = 行集；`additionalProperties: <schema>` = 动态命名记录（如图鉴）。
- 角色属性、背包、好感、世界时间各有专属插件，不要用 dimension 重复记录。

演化维度示例：

```yaml
dimensions:
  reputation:
    name: { zh-CN: 声望, en-US: Reputation }
    schema: { type: integer, minimum: 0, maximum: 100 }
    initialValue: 10
    updateRule: 完成居民委托后 +5；公开背信 -10。只计已完成的行为，不计承诺。
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
