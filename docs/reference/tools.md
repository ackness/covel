# 工具注册表

> 所有可供 LLM Runtime 调用的工具（Function Calling）。工具分为 builtin（框架内置）和 local（插件本地）两类。

---

## 概览

| 工具名 | 来源 | 所属插件 | 审批策略 | 描述 |
|--------|------|----------|----------|------|
| create-form | builtin | — | auto-allow | 创建玩家表单 |
| create-choices | builtin | — | auto-allow | 创建选项列表 |
| create-notification | builtin | — | auto-allow | 显示通知消息 |
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

## Local 工具

插件自带的工具，定义在插件的 `tools/` 目录下，使用 `tool()` 包装函数创建。

### unlock-codex-entries

**所属**: core-codex (`plugins/core-codex/tools/unlock-codex-entries.ts`)

批量解锁图鉴条目，每个条目生成一张"知识发现"UI 卡片。

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

**输出**: `{ unlocked, entries, ui }` — 含稀有度分级的 UI 卡片数组

---

### update-codex-entry

**所属**: core-codex (`plugins/core-codex/tools/update-codex-entry.ts`)

更新已有图鉴条目，追加新发现的信息。

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| entryId | string | ✓ | 要更新的条目 ID |
| appendContent | string | ✓ | 追加的新内容 |
| newTags | string[] | | 新增标签 |
| rarityUpgrade | enum | | 提升稀有度 |

**输出**: `{ updated, entryId, ui }` — 含更新动画的 UI 卡片

---

## 审批策略

工具调用经过 `ApprovalPipeline` 审批检查，当前规则（配置在 `apps/server/src/routes/v2/bootstrap.ts`）：

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
POST /v2/session/:id/submit-inputs

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

使用 `@covel/tools` 的 `tool()` 包装函数：

```typescript
import { z } from 'zod';
import { tool } from '@covel/tools';

export const myTool = tool({
  name: 'my-tool-name',
  description: '工具描述（会注入 LLM system prompt）',
  parameters: z.object({
    param1: z.string().describe('参数描述'),
  }),
  execute: async (params, context) => {
    // context: { sessionId, turnId, pluginId, runtimeId }
    return { result: params.param1 };
  },
});
```

如需玩家交互，在返回值中添加 `interaction`（见上方交互协议）。

在 `PLUGIN.md` frontmatter 中声明：

```yaml
tools:
  local:
    - ./tools/my-tool-name.ts
```
