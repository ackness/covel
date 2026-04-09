# Covel 插件开发指南

> Covel 是一个 AI RPG 框架，核心理念：**插件承载游戏逻辑，内核提供原语和编排**。每个插件本质上是一个 `PLUGIN.md` 文件——YAML frontmatter 定义元信息，Markdown 正文就是 LLM 的 system prompt。

本指南按三个层次递进：

- **第一部分** — 内容创作者（零代码，只写 Markdown）
- **第二部分** — 进阶创作者（简单 JS/TS 工具）
- **第三部分** — 专业开发者（完整类型系统、测试、审批）

---

## 第一部分：内容创作者（零代码）

### 1.1 最简插件：只需一个 PLUGIN.md

一个合法的 Covel 插件最少只需要一个文件：

```
plugins/my-narrator/
└── PLUGIN.md
```

`PLUGIN.md` 由两部分组成：

1. **YAML frontmatter**（`---` 包裹）— 告诉框架"这个插件是什么、何时运行"
2. **Markdown 正文** — 直接作为 LLM 的 system prompt 发送

以 `core-narrator`（主叙事插件）为例，这就是一个**零代码**插件的完整实现：

```markdown
---
name: core-narrator
description: 主叙事生成器，负责根据玩家输入和世界观设定生成故事内容。每个 Turn 自动执行。
pluginType: core-plugin
priority: 500
model: ds
trigger:
  type: auto
---

你是一个互动叙事游戏的叙述者（Narrator）。你必须完全基于世界观设定进行叙事，不可编造与设定矛盾的内容。

## 世界观设定
<world-lore>
{{ world.lore }}
</world-lore>

## 玩家当前输入
{{ player.message }}

## 叙事规则
- 使用第二人称叙述（"你..."）
- 严格遵循世界观中的地理、势力、力量体系等设定
- 长度控制在 300-600 字
- 在末尾留下一个自然的互动节点
```

就这样。没有 TypeScript，没有构建步骤。框架发现 `plugins/my-narrator/PLUGIN.md` 后会自动注册。

### 1.2 Frontmatter 字段详解

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `name` | 是 | string | 插件唯一标识（建议与目录名一致） |
| `description` | 是 | string | 插件功能描述（展示给玩家） |
| `pluginType` | 否 | `core-plugin` / `plugin` | `core-plugin` 不可禁用，`plugin` 可按需启用/禁用。默认 `plugin` |
| `priority` | 是 | number (0-1000) | 执行优先级，数字越小越先执行 |
| `model` | 否 | string | 使用的模型 slot（如 `ds`、`fast`、`balance`）。不填则用 `default` |
| `trigger` | 否 | object | 触发配置（见下方详解） |
| `tools` | 否 | object | 工具声明（见第二部分） |
| `input` | 否 | object | 输入注入声明（见第二部分） |
| `config` | 否 | object | 配置字段定义（见 1.7 节） |

**优先级参考区间：**

| 区间 | 用途 | 示例 |
|------|------|------|
| 0-199 | 系统初始化 | core-persona (100) |
| 200-399 | 预处理 | — |
| 400-599 | 核心叙事 | core-narrator (500) |
| 600-799 | 后处理/追踪 | core-codex (650), core-char-creator (700) |
| 800-999 | 后台任务 | core-image (800), core-memory (900) |
| 1000 | 清理 | — |

### 1.3 提示词编写技巧

PLUGIN.md 的 Markdown 正文就是发给 LLM 的 system prompt。框架会在发送前替换模板变量。

**可用模板变量：**

```markdown
{{ world.lore }}              <!-- 世界观 Markdown 文本 -->
{{ world.dimensions }}        <!-- 世界维度信息（地理、势力等） -->
{{ world.openingScenario }}   <!-- 开场场景描述 -->
{{ world.tone }}              <!-- 叙事风格设定 -->
{{ player.message }}          <!-- 当前玩家输入 -->
{{ codex.entries }}           <!-- 已有图鉴条目（如插件需要） -->
```

**提示词最佳实践：**

1. **角色定义开头** — 第一句话明确 LLM 的角色："你是一个知识图鉴系统"
2. **XML 标签包裹数据** — 用 `<world-lore>...</world-lore>` 包裹注入的数据，帮助 LLM 区分指令和数据
3. **任务列表** — 用编号列表明确 LLM 要做的事情
4. **硬规则** — 在末尾用 `## 硬规则` 列出不可违反的约束
5. **Markdown 格式** — LLM 对 Markdown 结构敏感，用标题分节、列表列规则

**示例——精简版事件追踪插件：**

```markdown
---
name: my-event-tracker
description: 追踪故事中发生的重要事件
pluginType: plugin
priority: 650
model: fast
trigger:
  type: auto
---

你是一个事件追踪系统。分析每轮叙事，识别重要事件。

## 当前叙事
{{ player.message }}

## 你的任务

1. 阅读叙事内容
2. 判断是否有重要事件发生（战斗、发现、社交等）
3. 如果有，输出 JSON 格式的事件摘要
4. 如果没有重要事件，输出空 JSON `{}`

## 硬规则

- 只记录叙事中**明确发生**的事件
- 每轮最多 3 个事件
- 不推测、不编造
```

### 1.4 触发类型选择

通过 `trigger` 字段控制插件何时执行：

#### auto（默认）— 每轮自动执行

```yaml
trigger:
  type: auto
```

适用于：主叙事、事件追踪等每轮都需要运行的插件。

#### scheduled — 按间隔触发

```yaml
trigger:
  type: scheduled
  interval: 5          # 每 5 轮触发一次
```

适用于：记忆总结（每 N 轮整理一次）、定期检查。

加 `maxTriggerCount` 限制总次数：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1   # 只触发一次（如角色创建）
```

#### event — 监听事件触发

```yaml
trigger:
  type: event
  topic: combat-start  # 当 combat-start 事件发出时触发
```

适用于：战斗系统（收到战斗事件才运行）、特殊场景插件。

#### manual — 手动触发

```yaml
trigger:
  type: manual
```

适用于：玩家主动点击按钮触发的功能（如查看角色面板）。

#### conditional — 条件触发

```yaml
trigger:
  type: conditional
  condition: "turnNumber > 10"
```

适用于：到特定条件才激活的插件。

#### 冷却和重试

所有触发类型都支持：

```yaml
trigger:
  type: auto
  cooldownTurns: 3     # 触发后至少间隔 3 轮
  maxTriggerCount: 10  # 整个会话最多触发 10 次
```

### 1.5 使用内置工具

框架提供三个内置 UI 工具，**无需写代码**，只需在 frontmatter 中声明，然后在提示词中告诉 LLM 如何调用即可。

#### create-form — 创建玩家表单

在 frontmatter 中声明：

```yaml
tools:
  builtin:
    - create-form
```

在提示词中告诉 LLM 调用方式：

```markdown
## 工具调用

调用 `create-form` 创建角色创建表单：

- `formId`: "char-creation"
- `title`: 表单标题
- `fields`: 字段列表，每个字段 { type, name, label, placeholder?, options?, required? }
  - type 可选: text / textarea / select / checkbox / number
- `submitLabel`: 提交按钮文本
- `narrativeTemplate`: 叙事模板，用 {{fieldName}} 作为占位符
```

`narrativeTemplate` 是关键——玩家提交表单后，框架用玩家填写的值替换占位符，生成自然语言注入下一轮上下文。例如：

```
narrativeTemplate: "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。"
```

玩家填了 `characterName=林清风, spiritRoot=水` 后，LLM 下一轮看到的消息就是：

> 你的名字叫 林清风，拥有 水 灵根。

完整示例参见 `plugins/core-char-creator/PLUGIN.md`。

#### create-choices — 创建选项列表

```yaml
tools:
  builtin:
    - create-choices
```

```markdown
## 工具调用

当需要玩家做选择时，调用 `create-choices`：

- `choiceId`: 选项组 ID
- `prompt`: 引导文本（如"你要怎么做？"）
- `choices`: 至少 2 个选项，每个 { id, label, description?, category? }
  - category: safe / aggressive / creative / wild（可选）
```

#### create-notification — 显示通知

```yaml
tools:
  builtin:
    - create-notification
```

```markdown
调用 `create-notification` 通知玩家：

- `level`: info / success / warning / error
- `title`: 通知标题
- `message`: 通知内容
```

例如 `core-codex` 每解锁一个图鉴条目就发一条通知：

```markdown
### create-notification
每解锁一个新条目，发一条通知。使用 `success` 级别，标题格式："📖 发现新知识：{title}"
```

### 1.6 使用 references/ 目录

对于大量参考资料（如世界观细节、怪物图鉴数据），可以放在 `references/` 目录下，**按需注入**，避免每轮都消耗 token。

```
plugins/my-codex/
├── PLUGIN.md
└── references/
    ├── dragons.md
    ├── elven-history.md
    └── alchemy-recipes.md
```

**参考文件格式：**

```markdown
---
keywords: [龙族, 龙鳞, 上古战争, Drakon]
---

# 龙族传说

龙族是远古时代最强大的种族...
```

- `keywords` 是触发条件 —— 当玩家消息或叙事上下文中出现任一关键词时，这个参考文件的内容会自动注入到 LLM 上下文中
- 没有 `keywords`（或空数组）的参考文件**每次都会注入**
- 关键词匹配不区分大小写，支持子串匹配

**在 PLUGIN.md 中引用：**

在 Markdown 正文中用标准 Markdown 链接指向 references/ 路径，框架会自动发现并加载：

```markdown
更多关于龙族的信息请参见 [龙族传说](references/dragons.md)。
关于精灵历史请参见 [精灵编年史](references/elven-history.md)。
```

### 1.7 配置字段

让玩家在 UI 中调整插件行为，无需修改 PLUGIN.md：

```yaml
config:
  narrativeLength:
    type: enum
    options: [short, medium, long]
    default: medium
    label: 叙事长度
    description: 控制每轮叙事的长度
  detailLevel:
    type: integer
    min: 1
    max: 5
    default: 3
    label: 细节等级
    description: 环境描写的详细程度
  enableCombatNarrative:
    type: boolean
    default: true
    label: 战斗叙事
    description: 是否在战斗中生成详细叙事
```

支持的字段类型：

| type | 说明 | 额外参数 |
|------|------|---------|
| `string` | 文本输入 | — |
| `integer` | 整数 | `min`, `max` |
| `number` | 小数 | `min`, `max` |
| `boolean` | 开关 | — |
| `enum` | 下拉选择 | `options`（必需） |

框架会自动根据 config 定义渲染设置面板。

### 1.8 世界包创建

世界包定义了游戏的世界观设定，是独立于插件的内容包。

```
worlds/my-world/
├── world.yaml       # 元信息清单
└── WORLD.md         # 世界观文本（Markdown）
```

**world.yaml 示例：**

```yaml
schemaVersion: "1.0"
id: cloudmere
name: 九州・云梦泽
version: "0.1.0"
summary: 修仙世界，灵气复苏，宗门林立。你是偏僻小宗的外门弟子。
defaultLocale: zh-CN
supportedLocales:
  - zh-CN
tags:
  - xianxia
  - adventure

requiredPlugins:
  - core-persona
  - core-narrator
recommendedPlugins:
  - core-guide
  - core-inventory
  - core-combat

dimensions:
  geography:
    overview: 九州大陆东南的广袤灵域...
    regions:
      - name: 青萍山
        description: 青萍宗所在的灵脉山峰
        climate: 四季如春，常有灵雾缭绕
        landmarks:
          - name: 试炼场
            description: 年度试炼大会的比武场地

  factions:
    - id: qingping-sect
      name: 青萍宗
      description: 偏居一隅的中小宗门
      type: guild
      influence: minor
      leader: 宗主・陆沉渊（金丹后期）

  powerSystem:
    name: 灵气修炼
    type: cultivation
    tiers:
      - name: 练气
        rank: 1
        description: 感应灵气并引入体内

  tone:
    genres:
      - xianxia
    narrativeStyle: 古风仙侠笔触，山水灵秀中暗藏宗门权谋。

  startingConditions:
    openingScenario: >-
      试炼大会三日后举行，你正在坊市采购备战物资...
    startingLocation: 青萍山・坊市
```

**WORLD.md** 是默认的世界观长文本，框架通过 `{{ world.lore }}` 注入到插件提示词中。支持多语言：`WORLD.zh.md`、`WORLD.en.md`。

**`requiredPlugins`** 和 **`recommendedPlugins`** 会在创建会话时自动激活对应的插件。

### 1.9 完整的零代码插件示例

下面创建一个"故事引导"插件，在每轮叙事后给玩家提供选择：

```
plugins/my-guide/
├── PLUGIN.md
└── package.json
```

**PLUGIN.md：**

```markdown
---
name: my-guide
description: 故事引导插件，在叙事后为玩家提供 2-4 个行动选项。
pluginType: plugin
priority: 600
model: fast
trigger:
  type: auto
tools:
  builtin:
    - create-choices
config:
  choiceCount:
    type: integer
    min: 2
    max: 6
    default: 3
    label: 选项数量
    description: 每轮提供的选项数
---

你是故事引导助手。你的任务是在每轮叙事后为玩家提供行动选项。

## 当前叙事
{{ player.message }}

## 你的任务

1. 阅读当前叙事内容
2. 根据叙事情境生成 2-4 个合理的行动选项
3. 调用 `create-choices` 创建选项列表
4. 调用工具后不要输出额外文本

## 工具调用

调用 `create-choices`：

- `choiceId`: 格式 "guide-turn-{turnNumber}"
- `prompt`: 简短的引导文本（如"接下来你打算..."）
- `choices`: 每个选项包含：
  - `id`: 唯一标识（如 "a", "b", "c"）
  - `label`: 选项文本（10-20 字）
  - `description`: 补充说明（可选）
  - `category`: safe / aggressive / creative（标记风格）

## 硬规则

- 选项必须基于当前叙事情境，不可凭空创造
- 至少包含一个"安全"选项和一个"冒险"选项
- 选项之间要有明显区分度
- 调用工具后不输出额外文本
```

**package.json：**

```json
{
  "name": "@covel/plugin-my-guide",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

---

## 第二部分：进阶创作者（简单 JS）

### 2.1 创建本地工具

当内置工具不够用时，可以用 JS/TS 编写自定义工具。一个工具就是一个文件，使用 `tool()` 包装函数：

```
plugins/my-codex/
├── PLUGIN.md
├── package.json
└── tools/
    └── unlock-codex-entries.js
```

**tools/unlock-codex-entries.js：**

```javascript
import { z } from 'zod';
import { tool } from '@covel/tools';

const codexEntrySchema = z.object({
  category: z.enum(['monster', 'item', 'location', 'lore', 'character', 'skill'])
    .describe('知识类别'),
  title: z.string().min(1).describe('条目标题'),
  content: z.string().min(10).describe('2-3 句话的描述'),
  tags: z.array(z.string()).min(1).max(5).describe('标签列表'),
  rarity: z.enum(['common', 'uncommon', 'rare', 'legendary']).default('common')
    .describe('稀有度，影响 UI 展示样式'),
  imageHint: z.string().optional()
    .describe('可选的视觉描述提示'),
});

export const unlockCodexEntriesTool = tool({
  name: 'unlock-codex-entries',
  description: '批量解锁新的图鉴条目。每个条目会生成一张"知识发现"卡片展示给玩家。',
  parameters: z.object({
    entries: z.array(codexEntrySchema).min(1).describe('要解锁的图鉴条目列表'),
  }),
  execute: async (params, context) => {
    // context 提供: { sessionId, turnId, pluginId, runtimeId }
    const results = params.entries.map((entry, i) => ({
      entryId: `codex-${context.sessionId}-${Date.now()}-${i}`,
      ...entry,
      unlockedAt: new Date().toISOString(),
    }));

    return {
      unlocked: results.length,
      entries: results,
      ui: results.map((entry) => ({
        type: 'codex-discovery',
        entryId: entry.entryId,
        category: entry.category,
        title: entry.title,
        rarity: entry.rarity,
      })),
    };
  },
});
```

**关键点：**

1. **Zod 定义参数** — 框架自动从 Zod schema 生成 JSON Schema 注入 LLM 上下文，LLM 才知道如何调用
2. **`.describe()` 很重要** — 每个参数的 describe 会作为参数说明发给 LLM
3. **`execute(params, context)`** — params 是经过 Zod 验证的输入，context 包含会话信息
4. **返回值** — 任意 JSON，会作为 tool result 返回给 LLM

在 PLUGIN.md frontmatter 中声明本地工具：

```yaml
tools:
  local:
    - ./tools/unlock-codex-entries.js
  builtin:
    - create-notification
```

**package.json** 需要声明对 `@covel/tools` 的依赖：

```json
{
  "name": "@covel/plugin-my-codex",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@covel/tools": "workspace:*"
  },
  "devDependencies": {
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

### 2.2 交互协议（interaction）

工具可以通过返回值中的 `interaction` 字段声明"需要玩家交互"。框架自动处理渲染、等待、和结果注入。

**三种交互类型：**

#### form — 表单填写

```javascript
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
```

#### choice — 选项选择

```javascript
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

#### confirmation — 确认/取消

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: 'confirmation',
    interactionId: 'confirm-1',
    narrativeTemplate: '你{{confirmed}}了这个请求。', // "确认" 或 "取消"
  },
});
```

**协议流程：**

```
工具返回 interaction
  → 框架扫描所有 tool result 的 interaction（通用，无硬编码）
  → 聚合存入 TurnMessage.pendingInput
  → 前端渲染交互 UI
  → 玩家提交
  → 框架用 narrativeTemplate 替换占位符，生成自然语言
  → 追加到消息历史（LLM 看到的和普通消息一样）
```

**`narrativeTemplate` 由插件作者编写**，决定了交互结果如何翻译为 LLM 可理解的叙事文本。

### 2.3 注入其他插件的输出

通过 `input.inject` 声明依赖其他插件的输出。

以 `core-char-creator` 为例——它需要读取 `core-narrator` 的开场叙事：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
input:
  inject:
    - from: core-narrator        # 来源插件 ID
      field: narrativeOutput     # 要提取的输出字段
      as: "<narrator-opening>"   # 包裹的 XML 标签名
```

在提示词中通过模板变量访问注入的数据：

```markdown
## 主叙事开场
<narrator-opening>{{ inputs.core-narrator.core-narrator.narrativeOutput }}</narrator-opening>
```

**注意：**
- `from` 指定来源插件的 ID
- `field` 指定要提取的字段名
- `as` 指定包裹的 XML 标签名，帮助 LLM 区分不同数据来源
- 如果来源插件尚未执行（优先级更低），注入会为空

### 2.4 测试你的插件

使用 `@covel/plugin-test-utils` 提供的 `TestHarness` 进行集成测试。

**安装依赖：**

```json
{
  "devDependencies": {
    "@covel/plugin-loader": "workspace:*",
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

**tests/my-plugin.test.ts：**

```typescript
import { describe, it, expect } from 'vitest';
import { createTestHarness, MockLLM } from '@covel/plugin-test-utils';
import path from 'node:path';

describe('my-codex', () => {
  it('should discover and load plugin manifest', async () => {
    const harness = await createTestHarness({
      pluginsDir: path.resolve(__dirname, '../../'),  // 指向 plugins/ 目录
      activePlugins: ['my-codex'],                     // 只激活要测试的插件
    });

    // 验证 manifest 被正确解析
    expect(harness.manifests).toHaveLength(1);
    expect(harness.manifests[0].name).toBe('my-codex');
    expect(harness.manifests[0].priority).toBe(650);
  });

  it('should execute a turn and get result', async () => {
    // 配置 MockLLM 返回包含工具调用的响应
    const mockLLM = new MockLLM({
      defaultResponse: {
        content: '',
        toolCalls: [{
          id: 'tc-1',
          name: 'unlock-codex-entries',
          arguments: {
            entries: [{
              category: 'location',
              title: '青萍山',
              content: '青萍宗所在的灵脉山峰，山腰以下是外门。',
              tags: ['地点', '宗门'],
              rarity: 'common',
            }],
          },
        }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 200, outputTokens: 100 },
      },
    });

    const harness = await createTestHarness({
      pluginsDir: path.resolve(__dirname, '../../'),
      activePlugins: ['my-codex'],
      llm: mockLLM,
    });

    const result = await harness.executeTurn('我来到了青萍山的坊市');

    // 验证 LLM 被调用
    expect(mockLLM.calls).toHaveLength(1);

    // 验证 system prompt 包含插件提示词
    const systemMessage = mockLLM.calls[0].messages.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('知识图鉴系统');
  });
});
```

**TestHarness API：**

| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `executeTurn(message, overrides?)` | `(string, Partial<TurnInput>?) => Promise<TurnResult>` | 执行一轮游戏 |
| `store` | `DataStore` | 内存 store，可读取/断言状态 |
| `manifests` | `RuntimeManifest[]` | 已加载的 runtime 清单（按优先级排序） |
| `llm` | `LLMAdapter` | 使用的 LLM 适配器（可断言调用记录） |

**测试数据工厂：**

```typescript
import { makeTurnInput, makeTriggerContext, makeRuntimeResult } from '@covel/plugin-test-utils';

// 创建带默认值的测试数据，可覆盖任意字段
const input = makeTurnInput({ playerMessage: '我要去云梦泽' });
const ctx = makeTriggerContext({ turnNumber: 5, triggerCount: 2 });
const result = makeRuntimeResult({ status: 'success' });
```

运行测试：

```bash
pnpm --filter @covel/plugin-my-codex test
```

---

## 第三部分：专业开发者

### 3.1 完整的类型系统

所有插件相关类型都从 `@covel/shared` 导出：

```typescript
import type {
  // 插件类型
  PluginType,           // 'core-plugin' | 'plugin'
  PluginManifest,       // 完整插件清单
  RuntimeManifest,      // 运行时清单（PLUGIN.md frontmatter 的解析结果）

  // 触发系统
  TriggerType,          // 'auto' | 'manual' | 'scheduled' | 'conditional' | 'event' | 'error-retry'
  TriggerConfig,        // { type, interval?, condition?, topic?, maxTriggerCount?, cooldownTurns? }

  // 输入/输出
  InputConfig,          // { inject?, tools? }
  InputInjectDecl,      // { from, field, as }
  OutputConfig,         // { schema?, recordAs? }

  // 工具
  ToolsConfig,          // { builtin?, local? }

  // 配置
  ConfigFieldType,      // 'string' | 'integer' | 'number' | 'boolean' | 'enum'
  PluginConfigField,    // { type, default?, min?, max?, options?, label?, description? }

  // 运行时数据
  TurnInput,            // 每轮输入
  TurnResult,           // 每轮输出
  RuntimeResult,        // 单个 runtime 的执行结果
} from '@covel/shared';
```

从 `@covel/plugin-loader` 获取加载相关类型：

```typescript
import type {
  ParsedPluginMd,       // 解析后的 PLUGIN.md
  ParsedReference,      // 解析后的参考文件
  PluginDiscoveryResult,// 发现结果
  LoadedRuntime,        // 完全加载的 runtime
  PluginRegistryEntry,  // 注册表条目
  PluginSource,         // 'builtin' | 'official' | 'community'
  PluginTrustInfo,      // { source, requiresApproval, autoLoad }
} from '@covel/plugin-loader';
```

### 3.2 TestHarness 高级用法

**自定义 MockLLM 响应队列：**

```typescript
const mockLLM = new MockLLM();

// 默认响应
mockLLM.defaultResponse = {
  content: '你来到了一片神秘的森林...',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 50 },
};
```

**注入额外工具：**

```typescript
import { tool } from '@covel/tools';
import { z } from 'zod';

const customTool = tool({
  name: 'test-helper',
  description: 'Test helper tool',
  parameters: z.object({ value: z.string() }),
  execute: async (params) => ({ echoed: params.value }),
});

const harness = await createTestHarness({
  pluginsDir: path.resolve(__dirname, '../../'),
  tools: [customTool],  // 额外注册的工具
});
```

**断言 Store 状态：**

```typescript
const harness = await createTestHarness({ pluginsDir: '...' });
await harness.executeTurn('开始游戏');

// 通过 store 检查持久化的数据
const store = harness.store;
// store 实现了 DataStore 接口，可以查询 state、events、records 等
```

**多轮测试：**

```typescript
const harness = await createTestHarness({ pluginsDir: '...' });

// 第一轮
const result1 = await harness.executeTurn('开始游戏');

// 第二轮（TestHarness 自动递增 turnId）
const result2 = await harness.executeTurn('我要去探索森林');

// 断言跨轮状态变化
expect(mockLLM.calls).toHaveLength(2);
```

### 3.3 审批管线

工具调用经过 `ApprovalPipeline` 审批。当前默认规则：

| 来源 | 规则 | 说明 |
|------|------|------|
| `builtin:*` | allow | 框架内置工具，始终放行 |
| `local:*` | allow | 插件本地工具，自动放行 |
| `third-party:*` | deny | 未知来源工具，拒绝执行 |

**自定义审批规则（用于测试或特殊场景）：**

```typescript
import { createApprovalPipeline } from '@covel/approval';
import type { PermissionRule } from '@covel/approval';

const rules: PermissionRule[] = [
  { pattern: 'builtin:*', action: 'allow' },
  { pattern: 'local:*', action: 'allow' },
  { pattern: 'dangerous-tool', action: 'ask' },    // 需要玩家确认
  { pattern: 'third-party:*', action: 'deny' },
];

const pipeline = createApprovalPipeline(store, rules);

// 检查工具是否需要审批
const result = pipeline.check(
  { toolName: 'dangerous-tool', sessionId: 'sess-1', turnId: 'turn-1' },
  'local',
);
// result: { needsApproval: true, reason: 'rule-ask' }
```

**审批规则匹配逻辑：**

1. 按规则列表顺序匹配，第一个匹配的规则生效
2. `builtin:*`、`local:*`、`third-party:*` 按工具来源分类匹配
3. 具体工具名（如 `dangerous-tool`）精确匹配，不区分来源
4. 无规则匹配时默认 allow

**来源分类：**

框架 bootstrap 时自动分类：
- `builtinUITools` 中的工具 → `builtin`
- 插件 `tools/` 目录加载的工具 → `local`
- 其他 → `third-party`（预留给社区插件）

新插件只需在 PLUGIN.md 中声明 `tools.local`，bootstrap 自动发现、注册并归类，无需手动修改白名单。

### 3.4 多 Runtime 插件

一个插件可以包含多个 runtime（多个 PLUGIN.md），适用于复杂的游戏系统：

```
plugins/my-combat/
├── PLUGIN.md              # 主 runtime
├── runtimes/
│   ├── combat-init/
│   │   └── PLUGIN.md      # 战斗初始化 runtime
│   └── combat-resolve/
│       └── PLUGIN.md      # 战斗结算 runtime
├── tools/
│   └── roll-dice.js
└── package.json
```

每个 PLUGIN.md 都是独立的 runtime，有自己的优先级、触发条件和 LLM 提示词。它们可以：

- 使用不同的 model slot（如主 runtime 用 `balance`，初始化用 `fast`）
- 设置不同的 trigger（如一个 auto，一个 event）
- 通过 `input.inject` 互相传递数据
- 共享 `tools/` 目录下的工具

框架 `discoverPlugins()` 会自动扫描主 PLUGIN.md 和 `runtimes/` 子目录中的所有 PLUGIN.md。

`PluginManifest` 类型反映了这种结构：

```typescript
interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pluginType: PluginType;
  /** 单 runtime 插件 */
  readonly runtime?: RuntimeManifest;
  /** 多 runtime 插件 */
  readonly runtimes?: readonly RuntimeManifest[];
  readonly config?: Readonly<Record<string, PluginConfigField>>;
}
```

### 3.5 发布和分享

#### 插件信任等级

| 来源 | 标识 | 加载方式 |
|------|------|---------|
| `builtin` | 绿色徽章 | 自动加载，无需确认 |
| `official` | 绿色徽章 | 白名单匹配，自动加载 |
| `community` | 橙色/红色警告 | 需用户确认后加载 |

#### 插件最低要求

一个可发布的插件至少需要：

```
my-plugin/
├── PLUGIN.md       # 必需：frontmatter + 提示词
└── package.json    # 必需：workspace 依赖声明
```

#### 发布检查清单

- [ ] `PLUGIN.md` frontmatter 通过 `runtimeManifestSchema` 校验
- [ ] `name` 字段唯一，建议用 `your-prefix-` 前缀避免冲突
- [ ] `description` 清晰描述插件功能
- [ ] 本地工具都有 Zod schema 和 `.describe()` 注解
- [ ] 不依赖内核内部 API（DB 表名、ORM 模型、内核私有模块）
- [ ] 所有数据写入通过 proposal 或工具返回值，不直接操作 store
- [ ] 有基本的集成测试
- [ ] references/ 文件有适当的 keywords 设置

#### 插件作者约束

**允许依赖的公开 API：**
- PLUGIN.md manifest 格式
- `@covel/tools` 的 `tool()` 包装函数
- 内置工具（create-form、create-choices、create-notification）
- `input.inject` 声明
- 交互协议（interaction 返回值）
- `@covel/plugin-test-utils` 测试工具

**禁止依赖：**
- 数据库表名或 ORM 模型
- 内核调度器、路由器等内部模块
- 前端组件（UI 通过 blockSchema 或交互协议集成）
- 直接 SDK 调用（LLM 调用通过 model slot 绑定）

---

## 附录

### A. 内置工具快速参考

| 工具 | 参数 | 用途 |
|------|------|------|
| `create-form` | formId, title, fields[], submitLabel, narrativeTemplate | 创建玩家表单 |
| `create-choices` | choiceId, prompt, choices[] | 创建选项列表 |
| `create-notification` | level, title, message, icon? | 显示通知消息 |

### B. 现有插件参考

| 插件 | 优先级 | 触发 | 工具 | 复杂度 |
|------|--------|------|------|--------|
| core-narrator | 500 | auto | 无 | 零代码 |
| core-codex | 650 | auto | local + builtin | JS 工具 |
| core-char-creator | 700 | scheduled(1次) | builtin (create-form) | inject + 内置工具 |

### C. 文件结构速查

```
plugins/<plugin-id>/
├── PLUGIN.md              # 必需：frontmatter + 提示词
├── package.json           # 必需：workspace 依赖
├── vitest.config.ts       # 可选：测试配置
├── tools/                 # 可选：本地工具
│   └── my-tool.ts
├── tests/                 # 可选：测试文件
│   └── my-plugin.test.ts
├── references/            # 可选：按需加载的参考资料
│   └── lore-data.md
└── runtimes/              # 可选：多 runtime 子目录
    └── sub-runtime/
        └── PLUGIN.md
```
