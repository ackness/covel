# Covel 插件系统 — 需求文档 v2

---

## 一、产品定位

Covel 是一个以 **Agent 编排为核心的互动叙事游戏框架**，参考 SillyTavern 的使用体验，但提供更现代、更灵活的 Agent 化插件系统。

框架本身只做一件事：**按照优先级顺序编排各个 Runtime 的执行，提供基础接口**。所有游戏功能均通过插件实现，框架不内置任何业务逻辑。

目标之一是完全脱离前端 UI，纯通过 API 访问即可完整运行游戏，前端 UI 是对 API 的可视化包装。

---

## 二、核心概念与术语

### 层级关系

```
Framework（编排框架）
  └── Plugin（插件）
        └── Runtime（Agent 的完整运行单元）
              ├── Tools（Function Calling）
              └── Output（Structured JSON）
```

### 执行时间轴（优先级 0–1000）

```
0 ──────────── 100 ───────────────── 500 ───────────────── 1000
    Pre-Game         Pre-Turn          Narrator              After-Turn
   （游戏初始化）     （玩家操作前）     （主叙事输出）         （操作后处理）
```

- **Pre-Game（0–100）**：游戏 session 启动阶段，用于初始化世界状态、角色属性、动态表单等
- **Pre-Turn（100–500）**：玩家发起一次操作后、叙事者输出前的处理阶段
- **Narrator（500）**：主叙事模型输出，是每个 Turn 的核心产出
- **After-Turn（500–1000）**：叙事者输出后的处理，包括状态更新、图像生成、日志记录等
- **Audit（1000）**：特殊保留位，专用于冲突审计插件

### Runtime 触发类型

Runtime 不一定在每个 Turn 自动执行，支持以下触发方式：

| 触发类型      | 说明                                        |
| ------------- | ------------------------------------------- |
| `auto`        | 每个 Turn 自动触发（默认）                  |
| `manual`      | 仅玩家手动触发                              |
| `scheduled`   | 每 N 个轮次触发一次                         |
| `conditional` | 满足特定条件时触发，如上下文 token 超过阈值 |
| `event`       | 监听特定事件触发                            |
| `error-retry` | 前序 Runtime 出错时触发                     |

Runtime 触发相关配置项：

- `maxTriggerCount`：整个 session 内最大触发次数
- `maxRetryCount`：错误重试最大次数
- `cooldownTurns`：两次触发之间的最小轮次间隔

---

## 三、插件系统设计

### 3.1 设计原则

**以内容创作者为第一用户**。不懂代码的玩家应该只需要写 Markdown 和简单的 YAML，就能创建、分享、使用插件。代码能力是可选的扩展层。

参考 Agent Skills 的**渐进式加载（Progressive Disclosure）**：

1. 框架启动时只加载插件的 `name` 和 `description`（极轻量）
2. Runtime 被激活时才加载完整的 `PLUGIN.md` 指令
3. `references/` 中的资料仅在被 `PLUGIN.md` 显式引用时按需加载

### 3.2 插件分类

| 类型     | `pluginType` 值 | 特点                                          |
| -------- | --------------- | --------------------------------------------- |
| 核心插件 | `core-plugin`   | 所有 Runtime 默认开启且不可关闭，只能调整配置 |
| 普通插件 | `plugin`        | 可按需启用/禁用，Runtime 可独立控制           |

### 3.3 插件包结构

#### 最简形态（纯文字，零代码）

适合内容创作者，一个文件夹加一个文件即可运行：

```
my-story-plugin/
└── PLUGIN.md
```

#### 标准形态（单 Runtime）

```
my-story-plugin/
├── PLUGIN.md              # 插件定义：frontmatter 元信息 + Markdown 提示词
├── output.schema.json     # 可选，Structured Output 的 JSON Schema 约束
└── references/
    └── world-lore.md      # 可选，按需加载的世界观资料
```

#### 多 Runtime 形态（复杂插件）

```
image-workflow-demo/
├── PLUGIN.md              # 人读说明文档（不注入模型）
└── runtimes/
    ├── prompt-optimizer/
    │   ├── PLUGIN.md          # 该 Runtime 的完整定义
    │   ├── output.schema.json
    │   ├── references/
    │   │   └── visual-guidelines.md
    │   ├── tools/
    │   │   └── fetch-style-reference.js
    │   └── tests/
    │       └── schema-shape.test.js
    └── image-generator/
        ├── PLUGIN.md
        ├── output.schema.json
        └── tests/
            └── schema-shape.test.js
```

### 3.4 PLUGIN.md 格式规范

`PLUGIN.md` 是插件系统的核心文件，YAML frontmatter 承载机器读取的元信息，Markdown body 是注入模型的提示词。

**最简示例（内容创作者）：**

```markdown
---
name: story-expansion
description: 在叙事者输出后扩展剧情细节，增加环境描写和人物情绪。当需要丰富场景时激活。
priority: 520
---

你是一个叙事增强 agent，负责补充更丰富的感官细节和人物内心描写。

根据当前叙事内容 `{{ inputs.narrator.narrativeOutput }}`，扩展以下内容：

- 环境的感官细节（气味、声音、光线）
- 人物的细微情绪变化

保持与原文风格一致，长度控制在 100-200 字。
```

**完整示例（开发者）：**

```markdown
---
name: prompt-optimizer
version: "1.0"
description: 将叙事内容优化为图像生成提示词。在图像生成前触发。
pluginType: plugin
priority: 480

# 模型配置（不填则继承系统默认）
model: deepseek-chat

# 触发配置
trigger:
  type: auto
  maxRetryCount: 2

# 工具声明
tools:
  builtin:
    - get-game-context
    - get-scene-info
  local:
    - ./tools/fetch-style-reference.js

# 上下文输入
input:
  # 直接注入上下文（以 XML 标签方式插入 system prompt）
  inject:
    - from: narrator/main
      field: narrativeOutput
      as: "<narrator-output>"
  # 通过 tool call 按需获取
  tools:
    - plugin: states-plugin
      runtime: character-state

# 输出配置
output:
  schema: ./output.schema.json
  recordAs: prompt-optimizer-result
---

你是一个视觉提示词优化 agent。

## 当前叙事

<narrator-output>{{ inputs.narrator.main.narrativeOutput }}</narrator-output>

## 你的任务

将上述叙事内容转化为适合图像生成的提示词，参考视觉风格指南：
[视觉指南](references/visual-guidelines.md)

## 输出格式

严格按照 output.schema.json 中定义的 JSON 格式输出。
```

#### PLUGIN.md frontmatter 字段说明

| 字段          | 必填          | 说明                                         |
| ------------- | ------------- | -------------------------------------------- |
| `name`        | ✅            | 插件/Runtime 唯一标识，小写加连字符          |
| `description` | ✅            | 激活时机说明，框架启动时加载用于判断是否激活 |
| `priority`    | ✅（Runtime） | 执行优先级 0–1000                            |
| `pluginType`  | 插件级        | `plugin` 或 `core-plugin`，默认 `plugin`     |
| `version`     | ❌            | 语义化版本号                                 |
| `model`       | ❌            | 绑定模型，不填继承系统默认                   |
| `trigger`     | ❌            | 触发配置，不填默认 `auto`                    |
| `tools`       | ❌            | 工具声明，不填默认无工具                     |
| `input`       | ❌            | 上下文输入声明                               |
| `output`      | ❌            | 输出格式声明                                 |
| `i18n`        | ❌            | 多语言绑定，指向对应语言的 PLUGIN 文件       |

---

## 四、上下文与输入系统

### 4.1 默认上下文

每个 Runtime 的上下文默认包含：

- 当前 Turn 的 narrator 输出（Narrator Runtime 之后的 Runtime 才可用）
- 玩家当前的输入消息
- 框架提供的基础变量（session info、turn number 等）

### 4.2 跨 Runtime 数据访问

有两种方式访问其他 Runtime 的数据，需要在 `PLUGIN.md` 的 `input` 字段显式声明：

**方式一：直接注入上下文（`inject`）**

将其他 Runtime 的输出结果以 XML 标签的形式直接插入到当前 Runtime 的上下文中。适合需要模型直接阅读的数据。

```yaml
input:
  inject:
    - from: narrator/main # pluginId/runtimeId
      field: narrativeOutput
      as: "<narrator-output>" # 包裹的 XML 标签名
```

**方式二：工具调用访问（`tools`）**

声明可通过 Function Calling 访问哪些其他 Runtime 的数据。模型可以按需调用，而不是全量注入。适合历史数据查询或按条件访问的场景。

```yaml
input:
  tools:
    - plugin: states-plugin
      runtime: character-state # 可访问当前及历史数据
```

### 4.3 References 的关键词触发（借鉴 ST World Info）

`references/` 目录下的文件支持在 frontmatter 中声明触发关键词，只有上下文中出现对应关键词时才会被加载注入，避免无意义的 token 消耗：

```markdown
---
# references/dragon-lore.md
keywords: [龙族, 龙鳞, 上古战争, Drakon]
---

# 龙族历史

...
```

---

## 五、工具（Tools）系统

### 5.1 工具来源

框架统一注册所有工具，模型侧看到的是统一的 tools 列表，不感知来源：

| 来源         | 声明方式                       |
| ------------ | ------------------------------ |
| 框架内置工具 | `tools.builtin` 中按 id 引用   |
| 插件私有工具 | `tools.local` 中按相对路径引用 |

### 5.2 框架内置工具（核心集）

内置工具保持最小化，覆盖最常见场景：

| 工具 ID               | 功能                              |
| --------------------- | --------------------------------- |
| `get-game-context`    | 获取当前游戏上下文摘要            |
| `get-narrator-output` | 获取 narrator 当前/历史输出       |
| `get-character-state` | 获取角色状态表数据                |
| `get-scene-info`      | 获取当前场景信息                  |
| `get-runtime-result`  | 获取任意 Runtime 的当前或历史结果 |
| `update-state`        | 更新状态表中的字段                |
| `query-table`         | 查询动态表单数据                  |
| `emit-event`          | 向事件总线发送事件                |

### 5.3 插件私有工具格式与注册机制

#### 工具命名规范

所有工具在框架内部统一注册为以下命名格式：

```
covel_{plugin_name}_{runtime_name}_{function_name}

# 示例
covel_image_workflow_prompt_optimizer_fetch_style_reference
covel_states_plugin_character_state_get_character_hp
```

框架自动完成命名转换，插件开发者只需写函数名，无需手动拼接。

---

#### JS 工具：`tool()` 包裹函数（推荐）

**为什么不用 `@tool` 装饰器语法？**

`@decorator` 语法在原生 Node.js ESM 中目前还不支持，需要 Babel 或 SWC 编译，违背"零构建直接运行"的原则。因此框架提供 `tool()` 包裹函数作为等价替代，语义完全相同，只是语法是函数调用：

```js
// tools/fetch-style-reference.js  (ESM，零构建)
import { tool } from "covel/sdk";

// tool() 自动完成：
// 1. 从参数定义生成 JSON Schema
// 2. 注册为 covel_image_workflow_prompt_optimizer_fetch_style_reference
// 3. 将函数包装为框架统一可调用格式
export default tool(
  {
    description: "根据风格名称获取视觉参考资料，用于优化图像生成提示词",
    parameters: {
      style: {
        type: "string",
        description: "风格名称，如 anime、realistic、watercolor",
      },
      limit: {
        type: "number",
        description: "返回结果数量",
        default: 3,
      },
    },
  },
  async ({ style, limit }) => {
    // 具体实现，直接写业务逻辑
    const results = await fetchStyleData(style, limit);
    return { references: results };
  },
);
```

**框架如何处理 `tool()` 的返回值：**

```
tool() 调用时
  ├── 读取 description → 作为 function calling 的 description 字段
  ├── 读取 parameters  → 自动转换为 JSON Schema（OpenAI/Anthropic 格式）
  ├── 读取插件上下文   → 生成 covel_{plugin}_{runtime}_{fn} 命名
  └── 注册到框架工具注册表
```

---

#### Python 工具：`@tool` 装饰器（Python 原生支持）

Python 本身原生支持装饰器语法，无需编译：

```python
# tools/fetch_style_reference.py
from covel.sdk import tool

@tool(description="根据风格名称获取视觉参考资料")
def fetch_style_reference(
    style: str,       # "风格名称，如 anime、realistic"
    limit: int = 3    # "返回结果数量"
) -> dict:
    """
    从资料库中检索与指定风格匹配的视觉参考资料。
    docstring 会作为工具 description 的补充说明。
    """
    results = fetch_style_data(style, limit)
    return {"references": results}
```

Python 的 `@tool` 装饰器做的事情与 JS 的 `tool()` 完全相同：

- 从类型注解（`str`、`int`）自动推导 JSON Schema 参数类型
- 从 docstring 和参数注释提取描述
- 自动注册到框架工具注册表

---

#### 框架内置工具的实现方式（开发者参考）

框架内置工具本身也使用相同的 `tool()` / `@tool` 接口实现，只是在框架初始化时自动注册、默认在白名单中。这意味着：

1. 内置工具和插件私有工具在模型侧的调用方式完全一致
2. 框架开发者扩展内置工具时使用相同的接口，不需要特殊处理
3. 插件开发者可以参考内置工具的源码了解最佳实践

---

#### 工具注册表与工具查找流程

```
Runtime 声明 tools.local: ["./tools/fetch-style-reference.js"]
  │
  ├── 框架加载文件，读取 default export（tool() 返回值）
  ├── 结合当前插件上下文，生成完整工具名
  │     covel_image_workflow_prompt_optimizer_fetch_style_reference
  ├── 注册到工具注册表（key: 完整名，value: { schema, handler }）
  └── 向模型提供时，将 schema 转换为目标模型格式
        OpenAI  → { type: "function", function: { name, description, parameters } }
        Anthropic → { name, description, input_schema }
```

---

#### 工具调用的持久化记录

每次工具调用（无论内置工具还是私有工具）都会被持久化记录，包含：

```json
{
  "toolCallId": "call_xxxx",
  "toolName": "covel_image_workflow_prompt_optimizer_fetch_style_reference",
  "pluginId": "image-workflow-demo",
  "runtimeId": "prompt-optimizer",
  "turnId": "turn-42",
  "input": { "style": "anime", "limit": 3 },
  "output": { "references": [...] },
  "durationMs": 120,
  "approvalStatus": "auto-allowed",
  "timestamp": "2025-01-01T00:00:00Z"
}
```

这份记录：

- 其他 Runtime 可通过 `get-runtime-result` 工具查询（当前 Turn 及历史）
- 作为审批管线的审计日志
- 作为 Audit Plugin 进行冲突裁决的输入依据

---

## 六、输出系统（Structured Output）

### 6.1 基本原则

所有 Runtime 的输出必须是结构化 JSON。

- **支持 Structured Outputs 的模型**（如 GPT-4o、Claude 3.5+）：通过 `response_format` + JSON Schema 强制约束
- **不支持 Structured Outputs 的模型**：在 system prompt 中注入 schema 描述，要求模型按格式输出，框架负责验证并在不合规时重试

### 6.2 输出 Schema

在 `output.schema.json` 中定义，如不提供，框架使用默认 schema：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["runtimeId", "pluginId", "output"],
  "properties": {
    "runtimeId": { "type": "string" },
    "pluginId": { "type": "string" },
    "turnId": { "type": "string" },
    "output": { "type": "object" },
    "metadata": { "type": "object" }
  }
}
```

### 6.3 Runtime 执行结果的统一记录格式

每个 Runtime 执行完毕后，框架将结果以统一格式存入记录，供其他 Runtime 查询：

```json
{
  "pluginId": "image-workflow-demo",
  "runtimeId": "prompt-optimizer",
  "runId": "uuid-xxxx",
  "turnId": "turn-42",
  "status": "success",
  "output": { ... },
  "toolCalls": [ ... ],
  "durationMs": 1240,
  "timestamp": "2025-01-01T00:00:00Z"
}
```

### 6.4 前端 UI 渲染（LLM-driven UI）

插件输出的 JSON 可以包含 UI 渲染指令，前端解析后动态渲染组件。

### 6.5 UI 渲染分层

**第一层：预定义组件库（框架内置，开箱即用）**

框架提供一套通用 UI 组件，覆盖游戏场景中最常见的展示需求。模型通过 Structured Outputs 直接输出符合组件 schema 的 JSON，前端按 `type` 字段路由到对应组件渲染：

```json
{
  "ui": [
    {
      "type": "stat-bar",
      "label": "HP",
      "value": 80,
      "max": 100,
      "color": "red"
    },
    {
      "type": "card",
      "title": "任务完成",
      "body": "你找到了失落的宝剑",
      "icon": "sword"
    },
    {
      "type": "choice-list",
      "prompt": "你要怎么做？",
      "options": ["攻击", "逃跑", "谈判"]
    },
    { "type": "image", "url": "...", "caption": "黑暗森林入口" },
    { "type": "table", "columns": ["道具", "数量"], "rows": [["治疗药水", 3]] },
    {
      "type": "notification",
      "level": "warning",
      "message": "你的 HP 低于 20%"
    }
  ]
}
```

框架内置的预定义组件类型（初始集合，持续扩展）：

| 组件 type      | 用途                     |
| -------------- | ------------------------ |
| `stat-bar`     | 属性条（HP、MP、经验等） |
| `card`         | 通用信息卡片             |
| `choice-list`  | 玩家选项列表             |
| `image`        | 图片展示                 |
| `table`        | 数据表格                 |
| `notification` | 系统通知/警告            |
| `dialog`       | 人物对话气泡             |
| `inventory`    | 道具栏                   |
| `map-marker`   | 地图标记                 |
| `progress`     | 任务/进度展示            |

**第二层：玩家自定义组件扩展**

玩家可以在插件的 `ui-components/` 目录下提供自定义组件，框架动态加载并注册到组件库：

```
my-plugin/
└── ui-components/
    ├── combat-hud.js       # 自定义战斗 HUD 组件
    └── skill-tree.js       # 技能树组件
```

自定义组件与内置组件使用相同的 JSON schema 接口，模型输出 `"type": "combat-hud"` 时前端自动路由到对应的自定义组件。组件本身的渲染实现（HTML/CSS/JS）由插件开发者提供。

**模型侧的使用方式**：

框架在每个 Runtime 的 system prompt 中自动注入当前可用的 UI 组件列表及其 schema 说明，模型按需在 output 的 `ui` 字段中输出渲染指令，不感知组件是内置还是自定义。

---

## 七、事件与消息路由系统

### 7.1 设计理念

消息是**双向的**：

- **LLM → 外部**：通过 `emit-event` 工具向外发送格式化事件，外部组件（前端 UI、其他服务）订阅并响应
- **外部 → LLM**：前端操作或外部系统向框架发送格式化消息，路由到对应的 Runtime 处理

### 7.2 统一消息格式

所有消息（内部事件、外部触发）共享同一种路由格式：

```json
{
  "type": "message | event | callback",
  "topic": "quest.completed",
  "payload": { ... },
  "targetRuntime": "quest-tracker/notifier",  // 可选，指定路由目标
  "sessionId": "xxx",
  "turnId": "xxx"
}
```

- `type: "message"`：发送给模型的对话消息，进入当前 Runtime 的上下文
- `type: "event"`：触发订阅该 topic 的所有回调
- `type: "callback"`：触发特定 Runtime 作为回调执行完整的 LLM Agent 流程

### 7.3 Runtime 作为事件回调

Runtime 可以声明自己监听某个事件 topic，当事件触发时自动执行：

```yaml
# PLUGIN.md frontmatter
trigger:
  type: event
  topic: quest.completed
```

回调既可以是：

- **轻量回调**：执行一个 JS/Python 脚本函数
- **完整 Runtime**：触发完整的 LLM Agent 流程（工具调用、结构化输出等）

---

## 八、Pre-Game 阶段与动态表单系统

### 8.1 Pre-Game 阶段的作用

优先级 0–100 的 Runtime 在玩家点击"开始游戏"之前执行，主要用于初始化工作：

- 加载/生成世界观状态表（角色属性、场景、技能、道具等）
- 验证插件依赖
- 初始化 session 级别的数据

### 8.2 动态表单

游戏世界的状态表结构因世界观而异，不是固定的。框架提供动态 CRUD 能力：

- **创建**：插件可以在 Pre-Game 阶段定义并创建表（字段名、类型、初始值）
- **查询**：所有插件只读访问所有表
- **修改**：通过 `update-state` 工具更新字段（写权限受审批管线控制）
- **删除**：session 结束时清理（数据本身持久化保留用于审计）

### 8.3 状态表变更历史

状态表的每次字段变更都保留完整历史记录，不覆盖旧值：

```json
{
  "table": "character",
  "field": "hp",
  "changeLog": [
    {
      "value": 100,
      "changedBy": "states-plugin/init",
      "turnId": "pre-game",
      "timestamp": "..."
    },
    {
      "value": 80,
      "changedBy": "combat-plugin/resolver",
      "turnId": "turn-5",
      "reason": "受到 20 点伤害"
    },
    {
      "value": 75,
      "changedBy": "status-effects/poison",
      "turnId": "turn-5",
      "reason": "毒素 5 点"
    },
    {
      "value": 95,
      "changedBy": "item-plugin/heal",
      "turnId": "turn-6",
      "reason": "使用治疗药水"
    }
  ],
  "currentValue": 95
}
```

变更历史用途：

- **审计**：可追溯每个字段值的完整变更来源
- **Audit Plugin 裁决依据**：冲突发生时可查看历史变更模式
- **调试**：开发插件时快速定位非预期的状态变化
- **回放**：理论上可以从任意一个历史快照重建游戏状态

### 8.3 世界观文件中的预定义状态

玩家/创作者可以在世界观文件（`references/` 或独立的 `.world` 文件）中预先定义状态表结构，游戏启动时直接加载，无需 LLM 重新生成：

```markdown
---
# references/character-states.md
type: state-schema
tables:
  - name: character
    fields:
      - name: hp, type: integer, default: 100
      - name: mp, type: integer, default: 50
      - name: gold, type: integer, default: 0
---
```

这套设计方便玩家之间分享自己设计的世界观元素。

---

## 九、插件配置系统

### 9.1 配置声明

插件可以在 `PLUGIN.md` frontmatter 或独立的 `config.schema.json` 中声明可配置项及默认值：

```yaml
config:
  outputLength:
    type: integer
    default: 150
    min: 50
    max: 500
    label: "输出长度（字）"
  writingStyle:
    type: enum
    options: [dramatic, calm, humorous]
    default: dramatic
    label: "叙事风格"
```

### 9.2 前端配置 UI

框架根据 config schema 自动渲染插件配置页面，无需插件自己开发 UI。如果需要高度自定义的 UI，插件可以提供自定义 UI 组件（预留接口）。

配置修改热生效，下一次 Runtime 执行时读取新配置，通过 `{{ config.outputLength }}` 在 `PLUGIN.md` 中引用。

---

## 十、Runtime 并发与冲突处理

### 10.1 并发执行规则

相同优先级的 Runtime 并行执行。执行依赖链由 `input.inject` 和 `input.tools` 声明决定：

- 如果 Runtime B 声明依赖 Runtime A 的输出，框架确保 A 完成后才启动 B
- 没有声明依赖关系的 Runtime，即使优先级相同也可以并行

### 10.2 写冲突处理

当并行的 Runtime 同时写入同一个状态表字段时：

1. 框架记录所有写操作，不丢弃任何一次
2. 将冲突数据传递给优先级 1000 的 **Audit Plugin**
3. Audit Plugin 的 Runtime 可以配置为仅在发生冲突时触发（`trigger.type: conditional`）
4. Audit Plugin 输出最终决策，框架应用到状态表

### 10.3 Runtime 执行失败处理

- 如果某个 Runtime 执行失败：
  - 检查其他 Runtime 是否声明了对它的依赖
  - 有依赖的 Runtime 跳过本次执行（记录跳过原因）
  - 无依赖的 Runtime 继续正常执行
- **最低保障原则**：Narrator（优先级 500）的正常运行是最高优先级，任何插件失败不得影响玩家读到故事的核心体验

---

## 十一、审批管线（Human-in-the-Loop）

### 11.1 设计原则

所有工具调用在执行前都经过审批管线，框架内置白名单机制：

- **框架内置工具 + 官方插件**：默认放行，无需用户确认
- **第三方插件的工具**：默认不放行，需要用户授权

### 11.2 阻塞等待机制

审批是**完全阻塞**的，没有超时概念：

- 工具调用触发审批请求后，当前 Runtime **暂停执行**
- 所有依赖该 Runtime 的后续 Runtime **同样不运行**
- 整个 Turn 的执行流**卡住等待**，直到玩家做出明确决策
- 只有玩家点击审批选项后，执行流才继续

这个设计确保了对敏感操作的完整控制，玩家不会因为没看到弹窗而被默默执行了未授权的操作。

### 11.3 审批选项（前端交互）

当工具调用需要授权时，前端展示三个选项：

| 选项                   | 效果                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| **本次放行**           | 仅本次调用放行，下次同一工具再次触发审批                                     |
| **Session 内永久放行** | 本 session 内该工具的所有调用自动放行，记录到持久化审批策略                  |
| **拒绝**               | 本次拒绝，框架将拒绝结果作为工具返回值传回 Runtime，Runtime 自行处理降级逻辑 |

### 11.4 审批状态的持久化

审批决策持久化存储，包含：

```json
{
  "approvalId": "uuid-xxxx",
  "toolName": "covel_third_party_plugin_runtime_fn",
  "decision": "allow-session",
  "decidedAt": "2025-01-01T00:00:00Z",
  "turnId": "turn-12",
  "sessionId": "session-abc"
}
```

Session 内永久放行的策略在 session 结束后自动清除，不跨 session 保留。

### 11.5 实现策略（参考 OpenCode/Codex）

参考 OpenCode 的 `permission` 系统设计：

```yaml
# 工具权限配置
permissions:
  "builtin:*": allow # 所有内置工具放行
  "third-party:*": ask # 第三方工具询问
  "local:*": allow # 本插件私有工具放行
```

**当前实现策略**：代码结构中预留完整的审批管线（每次工具调用都经过管线），内置工具默认 `allow` 直接通过，不阻塞。管线代码骨架存在，暂不实现前端弹窗交互，默认全部放行。未来接入第三方工具时开启弹窗逻辑。

---

## 十二、跨插件数据访问

### 12.1 访问原则

- 插件只能**只读**访问其他插件的执行结果
- 访问方式需要在 `PLUGIN.md` 的 `input` 字段中**显式声明**
- 未声明的跨插件访问，框架拒绝执行

### 12.2 访问范围

通过 `get-runtime-result` 内置工具，可以访问：

- 当前 Turn 内其他 Runtime 的结果
- 历史 Turn 的 Runtime 结果（按 turnId 查询）
- 特定字段或完整输出

---

## 十三、i18n 支持

- 所有框架内置插件完整支持 i18n
- 插件的 `PLUGIN.md` 支持多语言变体：`PLUGIN.zh-CN.md`、`PLUGIN.en-US.md`
- 框架根据用户界面语言设置，自动加载对应语言的 `PLUGIN.md`
- 所有 prompt、输出内容跟随前端 UI 的语言设置

---

## 十四、热重载与热插拔

- 插件文件修改后无需重启框架
- 框架监听插件目录变更，重新加载变更的插件
- 热重载不影响当前正在执行的 Turn（等待当前 Turn 完成后生效）
- 插件可以在游戏运行中安装/卸载（下一个 Turn 生效）

---

## 十五、日志系统

每次 Runtime 执行生成完整日志，包含：

- Runtime 基本信息（pluginId、runtimeId、priority、turnId）
- 执行状态（success / failed / skipped）
- 工具调用记录（调用参数、返回值、是否通过审批）
- 输入上下文摘要
- 输出结果
- 耗时、token 消耗
- 跳过原因（如有）

---

## 十六、测试系统

### 16.1 测试原则

每个 Runtime 有自己独立的测试目录 `tests/`，框架提供统一测试工具和环境。

### 16.2 测试分层

| 测试类型     | 目录                 | 说明                                |
| ------------ | -------------------- | ----------------------------------- |
| Schema 测试  | `tests/unit/`        | 验证 output.schema.json 格式正确性  |
| 集成测试     | `tests/integration/` | 使用 mock 数据测试 Runtime 完整流程 |
| 真实模型测试 | `tests/e2e/`         | 调用真实 LLM，验证输出符合预期      |

### 16.3 独立 API 测试

框架为每个 Runtime 提供独立的 HTTP 调用接口，方便开发者在不启动完整游戏的情况下测试单个 Runtime：

```
POST /api/runtime/invoke
{
  "pluginId": "image-workflow-demo",
  "runtimeId": "prompt-optimizer",
  "mockInput": { "narrativeOutput": "..." }
}
```

---

## 十七、标准对外 API

框架提供统一的 HTTP API，所有前端 UI 操作都通过 API 完成：

| 端点                        | 功能                                |
| --------------------------- | ----------------------------------- |
| `POST /session/start`       | 启动新游戏 session（触发 Pre-Game） |
| `POST /session/:id/turn`    | 玩家发起一次操作（触发完整 Turn）   |
| `GET /session/:id/results`  | 获取当前 Turn 所有 Runtime 的结果   |
| `GET /plugins`              | 获取所有已加载插件列表              |
| `GET /plugins/:id/config`   | 获取插件配置 schema                 |
| `PATCH /plugins/:id/config` | 更新插件配置                        |
| `POST /runtime/invoke`      | 独立调用单个 Runtime（测试用）      |
| `GET /events/subscribe`     | SSE 订阅事件流（前端实时更新）      |
| `POST /events/emit`         | 外部向框架发送事件                  |

---

## 十八、持久化存储系统

### 18.1 持久化范围

**所有内容都需要持久化**，包括：

| 数据类型         | 说明                                        |
| ---------------- | ------------------------------------------- |
| Runtime 执行结果 | 每次 Runtime 的完整输出 + 状态              |
| 工具调用记录     | 每次 tool call 的输入、输出、耗时、审批状态 |
| 状态表数据       | Pre-Game 创建的所有动态表单数据             |
| 事件记录         | 所有 emit/receive 的事件历史                |
| Session 信息     | session 元信息、Turn 序列、玩家操作历史     |
| 审批记录         | 每次工具调用的审批决策                      |
| 日志             | 完整的 Runtime 执行日志                     |

### 18.2 存储分层

```
持久化存储
├── session 级别（游戏过程中持续写入）
│   ├── runtime_results      每个 Turn 每个 Runtime 的输出
│   ├── tool_call_records    每次工具调用记录
│   ├── state_tables         动态表单的当前状态（含变更历史）
│   ├── event_log            事件收发历史
│   └── turn_log             每个 Turn 的执行摘要
│
└── 全局级别（跨 session 复用）
    ├── world_schemas        世界观预定义的状态表结构（玩家分享）
    ├── plugin_configs       玩家对插件的配置覆盖
    └── approval_policies    工具审批策略（session 内永久放行记录）
```

### 18.3 查询接口

其他 Runtime 通过 `get-runtime-result` 工具查询持久化数据：

```json
// 查询当前 Turn 某 Runtime 的结果
{ "pluginId": "narrator", "runtimeId": "main", "turnId": "current" }

// 查询历史 Turn 的结果
{ "pluginId": "narrator", "runtimeId": "main", "turnId": "turn-38" }

// 查询最近 N 条历史
{ "pluginId": "narrator", "runtimeId": "main", "last": 5 }
```

---

## 十九、Audit Plugin（冲突裁决）

### 19.1 触发条件

Audit Plugin 运行在优先级 1000，配置为 `trigger.type: conditional`，仅在以下情况触发：

- 同一个 Turn 内，多个 Runtime 对同一状态表字段产生了写冲突
- 框架检测到冲突后，自动将冲突数据传入 Audit Plugin 的上下文

### 19.2 裁决机制：LLM 作为裁判

Audit Plugin 调用 LLM 进行裁决，不是基于规则的机械合并：

```markdown
---
# Audit Plugin 的 PLUGIN.md（简化示意）
name: audit
pluginType: core-plugin
priority: 1000
trigger:
  type: conditional
  condition: has-write-conflicts
---

你是一个游戏状态裁判 agent。

## 冲突信息

本轮发生了以下写冲突：
{{ inputs.conflicts | xml }}

## 你的任务

分析每个冲突的上下文，基于游戏逻辑和叙事合理性，决定最终应采用哪个值。
对于每个冲突字段，输出最终值和裁决理由。

## 裁决原则

- 优先保留对玩家体验影响更大的变更
- 如果两个变更都合理，尝试合并（如 HP 同时被两个 Runtime 扣减，则叠加扣减）
- 如果无法合并，优先采用优先级更高的 Runtime 的结果
```

### 19.3 冲突数据格式

框架自动整理冲突信息传给 Audit Plugin：

```json
{
  "conflicts": [
    {
      "table": "character",
      "field": "hp",
      "originalValue": 100,
      "writes": [
        {
          "runtimeId": "combat-resolver",
          "pluginId": "combat-plugin",
          "priority": 520,
          "newValue": 80,
          "reason": "受到了 20 点伤害"
        },
        {
          "runtimeId": "poison-tick",
          "pluginId": "status-effects",
          "priority": 530,
          "newValue": 95,
          "reason": "毒素每轮造成 5 点伤害"
        }
      ]
    }
  ]
}
```

---

## 二十、补充设计细节

### 20.1 自定义 UI 组件权限边界

玩家提供的 `ui-components/` 组件在前端执行，权限边界如下：

- **允许**：纯渲染逻辑（DOM 操作、动画、样式）
- **允许**：访问框架公开的只读游戏 API（当前状态表数据、当前 Turn 信息等）
- **禁止**：任何写操作（不能调用 `update-state`、不能触发 `emit-event`）
- **禁止**：访问其他插件的内部数据、网络请求

框架通过向组件注入一个受限的 `covel.readonly` API 对象实现隔离，组件只能访问这个对象，无法访问完整的框架上下文。

### 20.2 审批阻塞期间的前端 UX

Turn 卡住等待审批时，前端需要提供清晰的视觉反馈：

- **执行流进度指示**：显示当前 Turn 的 Runtime 执行进度，已完成的标绿、等待审批的标黄、未开始的置灰
- **已完成的 Runtime 结果提前展示**：审批前已执行完毕的 Runtime 输出（如 Narrator 已输出的故事文本）应立即渲染给玩家，不需要等待整个 Turn 完成
- **审批弹窗**：明确显示是哪个插件的哪个工具、调用参数是什么，让玩家有足够信息做决策
- **等待状态提示**：明确告知玩家"游戏暂停，等待你的确认"

### 20.3 状态表变更历史的存储策略

采用**滑动窗口**模式管理历史记录：

```yaml
# 状态表历史配置（可在框架全局配置中覆盖）
stateHistory:
  mode: sliding-window
  windowSize: 100 # 每个字段最多保留最近 100 条变更记录
  keepSessionBoundary: true # session 开始时的初始值永久保留，不受窗口限制
```

设计理由：LLM 驱动的游戏状态字段数量有限（通常几十个），每个字段每 Turn 最多变更一次，100 条窗口对于大多数游戏场景完全足够审计和调试。Session 边界值（初始状态）永久保留，确保始终可以重建完整的变更链。

窗口满时，最旧的记录被移除，但会在移除前写入归档日志，保证数据不丢失（只是不在热存储中）。
