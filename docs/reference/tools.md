# 工具注册表

> 所有可供 LLM Runtime 调用的工具（Function Calling）。工具分为 builtin（框架内置）和 local（插件本地）两类。

---

## 概览

| 工具名 | 来源 | 所属插件 | 审批策略 | 描述 |
|--------|------|----------|----------|------|
| create-form | builtin | — | auto-allow | 创建玩家表单 |
| create-choices | builtin | — | auto-allow | 创建选项列表 |
| create-notification | builtin | — | auto-allow | 显示通知消息 |
| plugin-data-set | builtin | — | auto-allow | 写入插件持久化数据（单条） |
| plugin-data-set-batch | builtin | — | auto-allow | 批量写入插件持久化数据 |
| plugin-data-get | builtin | — | auto-allow | 读取当前插件持久化数据 |
| plugin-data-list | builtin | — | auto-allow | 列出当前插件持久化数据 |
| **create-character** | builtin | — | auto-allow | 创建角色（player/npc/companion），写 characters 表 + 镜像到 plugin-data |
| **update-character** | builtin | — | auto-allow | 按 id 更新角色描述/字段（shallow merge），自动 version++ |
| **list-characters** | builtin | — | auto-allow | 列出本 session 所有角色（session 作用域，跨插件可见） |
| **get-character** | builtin | — | auto-allow | 按 id 或 name 查找单个角色 |
| set-world-schema | local | core-world-init | auto-allow | 定义世界角色属性 Schema |
| set-world-entries-batch | local | core-world-init | auto-allow | 批量写入世界词条 |
| unlock-codex-entries | local | core-codex | auto-allow | 批量解锁图鉴条目 |
| update-codex-entry | local | core-codex | auto-allow | 更新已有图鉴条目 |

---

## Builtin 工具

框架级原语，定义在 `packages/tools/src/builtin/ui-tools.ts`。所有插件可通过 `tools.builtin` 声明引用，无需编写代码。

### create-form

创建一个需要玩家填写的表单。框架渲染表单，玩家提交后结果注入下一轮上下文。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| formId | string | ✓ | 表单唯一标识 |
| title | string | ✓ | 表单标题 |
| fields | FormField[] | ✓ | 表单字段列表 |
| submitLabel | string | ✓ | 提交按钮文本 |
| narrativeTemplate | string | ✓ | 叙事模板，含 `{{fieldName}}` 占位符 |

**FormField**: `{ type, name, label, placeholder?, options?, required?, defaultValue? }`
- type: `text` | `textarea` | `select` | `checkbox` | `number`

**使用者**: core-char-creator

---

### create-choices

创建选项列表供玩家选择。适用于决策点、分支剧情、NPC 对话选项。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| choiceId | string | ✓ | 选项组唯一标识 |
| prompt | string | ✓ | 引导文本（如"你要怎么做？"） |
| choices | Choice[] | ✓ | 选项列表（至少 2 个） |

**Choice**: `{ id, label, description?, category? }`
- category: `safe` | `aggressive` | `creative` | `wild` 等

**使用者**: 待实现（core-guide 计划使用）

---

### create-notification

在前端显示一条通知消息。适用于状态变化、获得物品、触发事件等。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| level | enum | ✓ | `info` / `success` / `warning` / `error` |
| title | string | ✓ | 通知标题 |
| message | string | ✓ | 通知内容 |
| icon | string | | 图标名称 |

**使用者**: core-codex

---

### plugin-data-set

将数据写入插件的持久化存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离，同 `(namespace, key)` 会覆盖旧值。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| namespace | string | ✓ | 数据命名空间（如 `schema`, `entries`, `config`） |
| key | string | ✓ | 数据键名 |
| value | unknown | ✓ | 要存储的 JSON 数据 |

**输出**: `{ success, namespace, key }`

---

### plugin-data-set-batch

批量写入多条数据到插件持久化存储。一次调用写入整个数组，避免逐条调用的 LLM 轮次开销。适用于需要一次性写入大量条目的场景（如世界初始化）。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| items | Array<{namespace, key, value}> | ✓ | 要批量写入的数据条目数组 |

每个 item:
| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| namespace | string | ✓ | 数据命名空间 |
| key | string | ✓ | 数据键名 |
| value | unknown | ✓ | 要存储的 JSON 数据 |

**输出**: `{ success, count, items: [{ namespace, key }] }`

**设计原则**: 框架提供通用批量写入能力。对于专用场景（如世界初始化），推荐插件创建自己的 local tools，用更精确的 schema 引导 LLM 生成正确结构的数据。

---

### plugin-data-get

从**当前插件**的持久化存储中读取单条数据。出于安全考虑，不允许跨插件读取。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| namespace | string | ✓ | 数据命名空间 |
| key | string | ✓ | 数据键名 |

**输出**: `{ found, namespace, key, value?, updatedAt? }`

---

### plugin-data-list

列出**当前插件**持久化存储中某个 namespace 下的所有数据条目。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| namespace | string | | 数据命名空间（不传则列出所有） |

**输出**: `{ count, items: [{ namespace, key, value, updatedAt }] }`

---

## Character 管理工具

框架级角色管理工具，定义在 `packages/tools/src/builtin/character-tools.ts`。写入 `characters` 表（session 作用域，跨插件可见），同时镜像到调用插件的 `plugin_data[pluginId][namespace="characters"][key=charId]`，让右侧面板通过现成的 `plugin-data.changed` SSE 通道实时更新。

### 文本优先（Text-first）约定

这一组工具（以及任何采用该约定的其他工具）的返回值包含一个特殊字段 `_text`：

- **LLM 看到的内容 = `_text` 的原始文本**，不带 JSON 包装
- **框架追踪 / 前端 trace UI 看到的是完整 `parsedResult` 对象**（含 `_text` + 结构化字段）

框架层面（`packages/runtime/tool-executor.ts`）检测 `_text` 字段：
- 如果存在且为字符串 → LLM tool message content 直接写原始文本
- 如果不存在 → 退回到旧的 `JSON.stringify(result)` 行为（向后兼容）

这样的分层让 LLM 看到的是紧凑可读的自然语言（省 token、降噪），而框架依然有结构化数据做调试和追踪。其他 builtin 工具（如 `plugin-data-*`、`create-form`）目前保持 JSON 格式不变。

---

### create-character

创建一个新的角色记录（玩家、NPC 或同伴）。同 session 内同 `(name, type)` 会自动去重 —— 返回已存在的角色 id，不会创建重复项。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| name | string | ✓ | 角色名称 |
| type | enum | ✓ | `player` / `npc` / `companion` |
| description | string | | 角色简短描述 |
| fields | Record<string, unknown> | | 属性键值对（应符合世界 schema 中的 character-attributes） |
| transitionPhase | string | | **仅对 type=player 有效**：创建后将 session 转入此 phase（通常 `"playing"`） |

**输出 (parsedResult)**: `{ _text, success, existed, characterId, name, type, phaseTransitioned }`

**LLM 看到的 `_text` 示例**：
```
Created npc "苏婉" as char-abc123. — 青萍宗外门首席弟子，冰灵根修士。
```
或当去重命中时：
```
Character "苏婉" (npc) already exists as char-abc123. No new record created. Use update-character to modify it.
```

**使用者**: `core-char-creator/player-init`（传 `transitionPhase: "playing"`）、`core-char-creator/character-tracker`（只创建 NPC）

---

### update-character

按 id 更新已有角色。`fields` 按 shallow merge 合并（新键覆盖旧键），`version` 自动 +1。适用于状态变化、装备变更、受伤、死亡等。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| id | string | ✓ | 要更新的角色 id |
| description | string | | 新描述（未传则保留原值） |
| fields | Record<string, unknown> | | 要合并的字段 |

**输出 (parsedResult)**: `{ _text, success, characterId, version }` 或 `{ _text, success: false, notFound: true }`

**LLM 看到的 `_text` 示例**：
```
Updated npc "苏婉" (char-abc123) → v2.
  hp: 100 → 60
  status: alive → wounded
```

---

### list-characters

列出本 session 所有角色（session 作用域，跨插件可见）。输出是**紧凑文本列表**，一行一个角色，包含 id / 名字 / 类型 / 版本 / 简短描述 —— 方便 LLM 快速对齐已知人物，需要完整属性时再单独调用 `get-character`。

**排序算法**：主键 `version desc`（版本越高 = 被交互次数越多 = 频率越高），次键 `updatedAt desc`（频率相同时最近 turn 的优先）。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| type | enum | | `player` / `npc` / `companion` 过滤 |

**输出 (parsedResult)**: `{ _text, count, characters: CharacterSnapshot[] }`

**LLM 看到的 `_text` 示例**：
```
Characters in session (3 total, sorted by frequency then recency):
1. 苏婉 [npc] char-abc (v3) — 青萍宗外门首席弟子，冰灵根修士，知晓野生灵脉秘密
2. 柳娘 [npc] char-def (v2) — 药王谷谷主，三百年前见过碧鳞龙
3. 柳无痕 [player] char-xyz (v1) — 青萍宗外门弟子，水灵根中品
```

---

### get-character

按 id 或 name 查询单个角色的**完整属性**（description、version、时间戳、全部 fields）。必须传入 id 或 name 其中之一。与 `list-characters` 的简洁列表形成对照，适合需要深入了解某个角色全部状态的场景。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| id | string | | 角色 id |
| name | string | | 角色名称（精确匹配） |

**输出 (parsedResult)**: `{ _text, found, character: CharacterSnapshot }` 或 `{ _text, found: false }`

**LLM 看到的 `_text` 示例**：
```
Character: 苏婉 [npc] char-abc123
Description: 青萍宗外门首席弟子，冰灵根修士。发现百灵沼泽深处一条野生灵脉...
Version: 3
Created: 2026-04-12T04:00:00.000Z
Updated: 2026-04-12T04:24:55.000Z

Attributes:
  hp: 60
  mp: 80
  maxHp: 100
  maxMp: 100
  level: 4
  lingGen: 冰灵根
  status: wounded
```

---

## Local 工具

插件自带的工具，定义在插件的 `tools/` 目录下，使用 `tool()` 包装函数创建。

### set-world-schema

**所属**: core-world-init (`plugins/core-world-init/tools/set-world-schema.js`)

定义世界角色属性 Schema。一次调用传入所有属性定义，存储到 `plugin_data` 的 `schema/character-attributes`。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| attributes | AttributeDef[] | ✓ | 角色属性定义数组（至少 1 个） |

**AttributeDef**:
| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| id | string | ✓ | 属性唯一标识 |
| name | string | ✓ | 属性显示名称 |
| type | enum | ✓ | `string` / `number` / `array` / `enum` / `boolean` |
| category | enum | ✓ | `stats` / `bio` / `abilities` / `equipment` / `social` |
| min/max | number | | 数值类型的范围 |
| defaultValue | unknown | | 默认值 |
| itemType | enum | | 数组元素类型（`string` / `number`） |
| options | string[] | | 枚举选项列表 |
| description | string | | 属性说明 |

**输出**: `{ success, attributeCount, categories }`

**使用者**: core-world-init/schema-gen

---

### set-world-entries-batch

**所属**: core-world-init (`plugins/core-world-init/tools/set-world-entries-batch.js`)

批量写入世界词条。一次调用传入所有词条（地理、阵营、货币等），存储到 `plugin_data` 的 `entries` namespace。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| entries | WorldEntry[] | ✓ | 世界词条数组（至少 1 个） |

**WorldEntry**:
| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| key | string | ✓ | 词条标识（如 `geography`, `factions`） |
| value | object | ✓ | 词条内容（任意 JSON 对象） |

**输出**: `{ success, count, keys }`

**使用者**: core-world-init/schema-gen

---

### unlock-codex-entries

**所属**: core-codex (`plugins/core-codex/tools/unlock-codex-entries.js`)

批量解锁图鉴条目，每个条目生成一张"知识发现"UI 卡片。

返回的 `entryId` 使用**语义短 ID** 格式（如 `codex-fire-magic`, `codex-3`），方便 LLM 在后续 `update-codex-entry` 调用中精确引用。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| entries | CodexEntry[] | ✓ | 要解锁的条目列表 |

**CodexEntry**:
| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| category | enum | ✓ | `monster` / `item` / `location` / `lore` / `character` / `skill` |
| title | string | ✓ | 条目标题 |
| content | string | ✓ | 2-3 句话描述 |
| tags | string[] | ✓ | 标签列表（1-5 个） |
| rarity | enum | | `common`(默认) / `uncommon` / `rare` / `legendary` |
| imageHint | string | | 视觉描述提示 |

**输出**: `{ unlocked, entries, ui }` — 含稀有度分级的 UI 卡片数组。每个 entry 包含 `entryId`（短 ID）。

**ID 生成**: 使用 `shortIdBatch('codex', titles, sessionId)`，英文标题生成语义 slug（`codex-fire-magic`），CJK 标题回退为计数器（`codex-1`），同一批次内自动去重。

---

### update-codex-entry

**所属**: core-codex (`plugins/core-codex/tools/update-codex-entry.js`)

更新已有图鉴条目，追加新发现的信息。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| entryId | string | ✓ | 要更新的条目短 ID（如 `codex-fire-magic`） |
| appendContent | string | ✓ | 追加的新内容 |
| newTags | string[] | | 新增标签 |
| rarityUpgrade | enum | | 提升稀有度 |

**输出**: `{ updated, entryId, ui }` — 含更新动画的 UI 卡片

---

## 短 ID（LLM 友好实体引用）

工具中需要 LLM 传入或引用的实体 ID 应使用**短语义 ID** 而非 UUID。UUID 对 LLM 有两个问题：

1. **Token 效率低** — 36 字符需 8-10 个 token
2. **难以精确复制** — LLM 容易在长随机字符串中出错

### 设计原则

| 层 | 格式 | 用途 | 示例 |
|---|---|---|---|
| **存储层** | UUID | DB 主键、API 路由 | `550e8400-e29b-41d4...` |
| **LLM 层** | 短 ID | 工具参数、返回值、prompt 中引用 | `codex-fire-magic`, `char-1` |

### 使用方法

框架提供 `shortId()` 和 `shortIdBatch()` 两个工具函数（`@covel/tools`），通过工厂注入提供给插件本地工具：

```javascript
// 插件工具文件接收注入
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: 'my-tool',
    parameters: z.object({ ... }),
    execute: async (params, context) => {
      // 单个 ID
      const id = shortId('item', 'Dragon Sword', context.sessionId);
      // → 'item-dragon-sword'

      // 批量 ID（自动去重）
      const ids = shortIdBatch('codex', ['Fire Magic', 'Fire Magic', '龙息术'], context.sessionId);
      // → ['codex-fire-magic', 'codex-fire-magic-2', 'codex-1']
    },
  });
}
```

### ID 格式规则

| 输入 | 输出 | 说明 |
|------|------|------|
| `shortId('char', 'Dragon Knight', sid)` | `char-dragon-knight` | 英文 → 语义 slug |
| `shortId('item', 'Fire Sword', sid)` | `item-fire-sword` | 英文 → 语义 slug |
| `shortId('codex', '龙息术', sid)` | `codex-1` | CJK → session 内计数器 |
| `shortId('npc', '林若风', sid)` | `npc-2` | CJK → session 内计数器 |
| `shortIdBatch('codex', ['A', 'A'], sid)` | `['codex-a', 'codex-a-2']` | 批量自动去重 |

---

## 审批策略

工具调用经过 `ApprovalPipeline` 审批检查，当前规则（配置在 `apps/server/src/routes/api/bootstrap.ts`）：

| 来源分类 | 规则 | 说明 |
|----------|------|------|
| `builtin:*` | **allow** | 框架内置工具，始终放行 |
| `local:*` | **allow** | 已发现的插件本地工具，自动放行 |
| `third-party:*` | **deny** | 未知来源工具，拒绝执行 |

### 来源分类逻辑

Bootstrap 时自动分类：
- `builtinUITools` 中的工具 → `builtin`
- 插件 `tools/` 目录加载的工具 → `local`
- 其他 → `third-party`（当前不存在，预留给社区插件）

### 新增插件的工具

新插件只需在 `PLUGIN.md` frontmatter 中声明 `tools.local` 或 `tools.builtin`，bootstrap 会自动发现、注册并归类为对应来源，无需手动修改白名单。

---

## 交互协议（interaction）

工具可以通过返回值中的 `interaction` 字段声明"需要玩家交互"。框架自动聚合所有交互、返回给前端、等待玩家响应、然后将结果翻译为自然语言注入下一轮上下文。

### 协议流程

```
工具 execute() 返回 { ..., interaction: InteractionPayload }
  ↓ turn-executor 扫描所有 tool result 的 interaction（通用，无硬编码工具名）
  ↓ 聚合为数组存入 TurnMessage.pendingInput
  ↓ 返回 TurnResult.pendingInputs（支持多插件、多交互）
  ↓ 前端渲染所有交互 UI
  ↓ 玩家提交 POST /submit-inputs { submissions: [...] }
  ↓ 每个 submission 用 narrativeTemplate 翻译为自然语言
  ↓ 追加到消息历史（纯文本，LLM 看到的和普通消息一样）
```

### 交互类型

| 类型 | 用途 | 模板占位符 |
|------|------|-----------|
| `form` | 表单填写 | `{{fieldName}}` — 玩家填写的字段值 |
| `choice` | 选项选择 | `{{selectedId}}`, `{{selectedLabel}}` — 玩家选择的选项 |
| `confirmation` | 确认/取消 | `{{confirmed}}` — "确认" 或 "取消" |

### 返回值示例

```typescript
// 表单交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: 'form',
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate: '你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。',
  },
});

// 选项交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: 'choice',
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: '你思考片刻后决定：{{selectedLabel}}。',
  },
});
```

**`narrativeTemplate` 由插件作者编写**，决定了交互结果如何翻译为叙事文本。框架只负责替换占位符。

### 提交 API

```
POST /api/session/:id/submit-inputs

// 新格式（支持多交互）
{ "turnId": "...", "submissions": [
    { "interactionId": "form-1", "type": "form", "values": { "name": "林清风" } },
    { "interactionId": "choice-1", "type": "choice", "values": { "selectedId": "a", "selectedLabel": "跟随黑袍人" } }
  ]
}

// 旧格式（向后兼容）
{ "turnId": "...", "formId": "form-1", "values": { "name": "林清风" } }
```

---

## 创建新工具

### 方式一：工厂函数（推荐）

插件本地工具使用工厂函数模式，框架通过注入提供 `tool`, `z`, `shortId`, `shortIdBatch`：

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId }) {
  return tool({
    name: 'my-tool-name',
    description: '工具描述（会注入 LLM system prompt）',
    parameters: z.object({
      param1: z.string().describe('参数描述'),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId }
      const id = shortId('item', params.param1, context.sessionId);
      return { id, result: params.param1 };
    },
  });
}
```

**注入对象**:

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool` | function | `tool()` 包装函数，定义工具参数和执行逻辑 |
| `z` | object | Zod schema 库，用于参数验证 |
| `shortId` | function | `shortId(prefix, label, sessionId)` — 生成单个短语义 ID |
| `shortIdBatch` | function | `shortIdBatch(prefix, labels, sessionId)` — 批量生成短 ID |
| `store` | DataStore | DataStore 实例，用于直接读写持久化数据（如批量操作） |

### 方式二：直接导出（TypeScript）

```typescript
import { z } from 'zod';
import { tool } from '@covel/tools';

export const myTool = tool({
  name: 'my-tool-name',
  description: '工具描述',
  parameters: z.object({
    param1: z.string().describe('参数描述'),
  }),
  execute: async (params, context) => {
    return { result: params.param1 };
  },
});
```

> 注意：直接导出模式无法使用 `shortId` 注入，需自行从 `@covel/tools` 导入。

### 声明方式

如需玩家交互，在返回值中添加 `interaction`（见上方交互协议）。

在 `PLUGIN.md` frontmatter 中声明：

```yaml
tools:
  local:
    - ./tools/my-tool-name.js
```
