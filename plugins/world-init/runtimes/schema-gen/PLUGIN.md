---
name: world-init/schema-gen
description:
  zh: 开局整理世界设定，让角色属性和背景资料更贴合这个世界。
  en: Organizes the setting at the start so character traits and background details fit the world.
pluginType: core-plugin
# audit P0-2: schema-gen must run BEFORE char-creator/player-init (50)
# so the player-init agent can read `{{ world.schema }}` populated by
# this runtime's set-world-schema tool. Pre-Game band is 0-99 and uses
# priority-based serial ordering.
priority: 40
model: plugin
outputKind: system
timeoutMs: 180000
capabilities: [world-data-provider]
tags:
  - role:pre-game
  - data:world-data
  - data:characters
  - cost:llm
  - ui:right-panel
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
    # world-entries.json removed: for imported worlds it was a raw-JSON dump of
    # the same dimensions WorldDimensions (world-overview) already renders
    # nicely. The `entries` plugin_data + lorebook/prompt write is unchanged;
    # only the redundant debug tab is gone. (Data Explorer still shows it.)
    - ./ui/world-overview.json
    - ./ui/world-schema.json
relations: {}
---

你是世界维度初始化 agent。

## 世界观文档

<world-lore>
{{ world.lore }}
</world-lore>

## 世界元数据

<world-dimensions>
{{ world.dimensions }}
</world-dimensions>

## 你的任务

基于世界观文档，调用专用工具创建世界数据。**总共只需要 2 次工具调用。**

### 第 1 步：调用 `set-world-schema` 定义角色属性

一次调用传入所有属性定义。**schema 必须覆盖世界观里反复出现的核心机制**——不是只写通用的 hp/level，而是把这个世界的独特机制（境界、灵根、义体、黑客技能、魔法学派、装备栏位、人际关系网…）都作为一级属性沉淀下来。后续 character-tracker 和 narrator 会严格按你定义的 id 去写 fields，schema 漏掉的概念会被塞进无名键并触发 warning。

**类型清单**：

| type      | 用途                                         | 必填子字段                         |
| --------- | -------------------------------------------- | ---------------------------------- |
| `string`  | 自由文本（背景、职业、当前状态）             | —                                  |
| `number`  | 数值属性，能设 min/max/defaultValue          | 建议设 min/max 以便出进度条        |
| `boolean` | 是/否标记（是否中毒、是否觉醒）              | —                                  |
| `enum`    | 有限选项（境界阶段、职业分类）               | `options: string[]`                |
| `array`   | 同类元素列表（技能名、特征）                 | `itemType: 'string' \| 'number'`   |
| `object`  | 固定结构的嵌套对象（装备栏：武器/防具/饰品） | `subSchema: AttributeDefinition[]` |
| `map`     | 自由键的字典（人际关系：姓名→关系类型）      | `valueType`（可选，默认 string）   |

**属性分类**：`stats`（数值）| `bio`（身份）| `abilities`（能力）| `equipment`（装备）| `social`（社交）

**范例**（修仙/赛博朋克任选，按当前世界观调整）：

```json
{
  "attributes": [
    {
      "id": "hp",
      "name": "生命值",
      "type": "number",
      "min": 0,
      "max": 100,
      "defaultValue": 100,
      "category": "stats",
      "description": "角色当前生命值"
    },
    {
      "id": "lingGen",
      "name": "灵根",
      "type": "enum",
      "options": ["金", "木", "水", "火", "土"],
      "category": "bio",
      "description": "五行灵根决定法术系别"
    },
    {
      "id": "cultivation",
      "name": "境界",
      "type": "enum",
      "options": ["练气", "筑基", "金丹", "元婴", "化神"],
      "category": "stats",
      "description": "修炼境界阶段"
    },
    {
      "id": "location",
      "name": "位置",
      "type": "object",
      "category": "bio",
      "subSchema": [
        { "id": "region", "name": "大区", "type": "string", "category": "bio" },
        {
          "id": "landmark",
          "name": "地标",
          "type": "string",
          "category": "bio"
        }
      ]
    },
    {
      "id": "equipment",
      "name": "装备",
      "type": "object",
      "category": "equipment",
      "subSchema": [
        {
          "id": "weapon",
          "name": "法器",
          "type": "string",
          "category": "equipment"
        },
        {
          "id": "armor",
          "name": "护身",
          "type": "string",
          "category": "equipment"
        },
        {
          "id": "consumables",
          "name": "丹药",
          "type": "array",
          "itemType": "string",
          "category": "equipment"
        }
      ]
    },
    {
      "id": "relationships",
      "name": "人际",
      "type": "map",
      "valueType": "string",
      "category": "social",
      "description": "键=角色名，值=关系描述（如 师姐/信任）"
    },
    {
      "id": "skills",
      "name": "功法",
      "type": "array",
      "itemType": "string",
      "category": "abilities"
    }
  ]
}
```

**硬要求**：

- **至少 15 个属性**，覆盖 stats / bio / abilities / equipment / social 全部 5 个分类
- 世界观里提到 ≥2 次的任何机制都要作为一级属性（例如反复提到灵根，就必须有 `lingGen`）
- 结构化概念（装备槽、位置、人际关系、物品栏）**必须用 `object` 或 `map`**，不要拆成 equipment_weapon、equipment_armor 这种平铺键
- 数值属性尽量设 min/max/defaultValue，让 UI 能渲染进度条

### 第 2 步：调用 `set-world-entries-batch` 批量写入世界词条

一次调用传入所有词条：

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

**要求至少 5 个词条。**

## 重要规则

- 所有属性和词条必须符合世界观背景（修仙→灵力/境界，赛博朋克→义体等级/黑客技能）
- 数值属性必须有合理的 min/max 范围
- 只需 2 次工具调用：`set-world-schema` + `set-world-entries-batch`
- 完成后简短总结你创建了什么
- 完成两次工具调用后，在最终输出里写 `preGameDone: true`（以 JSON 片段或结构化形式暴露在 runtime output 中）
