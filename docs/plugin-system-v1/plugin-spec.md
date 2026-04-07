# 插件包规格（Plugin Package Specification）

时间：2026-04-07  
状态：草案

## 1. 设计目标

Covel 的插件系统不是“给框架注入代码”的传统扩展系统，而是一个 **runtime-first 的 agent 编排包规格**。

V1 的设计目标：

- 插件是一个或多个 runtime 的集合
- runtime 是完整 agent，拥有自己的 prompt、模型、tool 集和输出 schema
- 框架只负责编排、数据基础设施、审批、日志和热重载
- 插件通过公开合同扩展框架，而不是修改框架代码

## 2. 包结构

### 2.1 插件根目录

```text
plugin-name/
  plugin.json
  PLUGIN.md
  PLUGIN.en-US.md              # 可选
  runtimes/
    <runtime-id>/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
      tools/
      scripts/
      references/
      tests/
```

说明：

- `plugin.json` 是插件壳
- `PLUGIN.md` 是插件公共 prompt
- 真正的执行声明在各 runtime 自己的 `runtime.json`
- 单 runtime 插件也建议使用同一结构，只是 `runtimes/` 下只有一个目录

### 2.2 单 runtime 退化规则

如果插件没有显式声明多个 runtime，可以把该插件视为只有一个默认 runtime。

推荐仍然保持：

```text
plugin-name/
  plugin.json
  PLUGIN.md
  runtimes/
    default/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
```

## 3. plugin.json

`plugin.json` 只放插件级聚合信息，不再承载所有 runtime 的完整执行细节。

### 3.1 建议结构

```json
{
  "schemaVersion": "covel.plugin/v1",
  "id": "core-states",
  "pluginType": "core-plugin",
  "displayName": {
    "zh-CN": "状态管理",
    "en-US": "State Manager"
  },
  "version": "0.1.0",
  "author": "covel",
  "description": {
    "zh-CN": "负责动态表结构、状态追踪与共享状态读写。",
    "en-US": "Owns dynamic table schemas, state tracking, and shared state access."
  },
  "defaultLocale": "zh-CN",
  "supportedLocales": ["zh-CN", "en-US"],
  "runtimeIds": [
    "schema-builder",
    "data-initializer",
    "state-tracker"
  ]
}
```

### 3.2 字段约束

| 字段 | 说明 |
|------|------|
| `schemaVersion` | 插件规格版本 |
| `id` | 插件唯一 ID |
| `pluginType` | `"core-plugin"` 或 `"plugin"` |
| `displayName` | i18n 文本 |
| `version` | 插件版本 |
| `author` | 作者信息 |
| `description` | i18n 文本 |
| `defaultLocale` | 默认语言 |
| `supportedLocales` | 支持的语言列表 |
| `runtimeIds` | 该插件包含的 runtime 列表 |

## 4. 公共 Prompt

插件根目录的 `PLUGIN.md` 是插件公共 prompt。

运行时合并规则：

```text
最终 runtime prompt =
  plugin/PLUGIN.md
  + runtime/instructions.md
  + locale 指令
  + 当前 runtime 可用的 tool definitions
  + 由框架组装的上下文
```

要求：

- 所有 runtime 自动继承 `PLUGIN.md`
- runtime 不允许跳过公共 prompt
- locale 必须显式注入，要求最终输出使用当前前端语言

## 5. runtime.json

### 5.1 建议结构

```json
{
  "id": "state-tracker",
  "displayName": {
    "zh-CN": "状态追踪器",
    "en-US": "State Tracker"
  },
  "priority": 550,
  "trigger": {
    "type": "turn"
  },
  "limits": {
    "maxRunsPerSession": null,
    "maxRunsPerTurn": 1
  },
  "instructionsRef": "instructions.md",
  "outputSchemaRef": "output.schema.json",
  "llmConfigRef": "llm.toml",
  "settings": [
    {
      "key": "trackingDetail",
      "type": "enum",
      "label": {
        "zh-CN": "追踪精度",
        "en-US": "Tracking Detail"
      },
      "default": "normal",
      "options": [
        { "value": "brief", "label": { "zh-CN": "简洁", "en-US": "Brief" } },
        { "value": "normal", "label": { "zh-CN": "标准", "en-US": "Normal" } },
        { "value": "detailed", "label": { "zh-CN": "详细", "en-US": "Detailed" } }
      ]
    }
  ],
  "systemTools": [
    "kernel:query_records",
    "kernel:query_tables",
    "kernel:write_table",
    "kernel:emit_domain_event"
  ],
  "toolImports": [
    "core-states.update-character"
  ],
  "tableAccess": {
    "read": [
      "core-states.character",
      "core-states.world",
      "plugin.*"
    ],
    "writeOwnedOnly": true
  }
}
```

### 5.2 字段约束

| 字段 | 说明 |
|------|------|
| `id` | runtime 唯一 ID，插件内唯一 |
| `displayName` | i18n 文本 |
| `priority` | 0-1000 |
| `trigger` | 触发方式 |
| `limits` | 每 session / 每 turn 次数限制 |
| `instructionsRef` | runtime 指令文件 |
| `outputSchemaRef` | 结构化输出 schema |
| `llmConfigRef` | runtime 自己的 `llm.toml` |
| `settings` | runtime 级配置 schema |
| `systemTools` | 该 runtime 申请使用的内置工具 |
| `toolImports` | 该 runtime 声明需要导入的外部 plugin tools |
| `tableAccess.read` | 申请读取的表名或正则模式 |
| `tableAccess.writeOwnedOnly` | 是否仅允许写 owner 为本插件的表，V1 固定应为 `true` |

## 6. Trigger 规格

### 6.1 触发类型

V1 支持：

- `pre-game-once`
- `turn`
- `event`
- `manual`
- `approval-callback`

示例：

```json
{ "type": "pre-game-once" }
{ "type": "turn" }
{ "type": "event", "events": ["quest.completed"] }
{ "type": "manual", "action": "image.generate" }
{ "type": "approval-callback", "tool": "external.search" }
```

### 6.2 次数限制

规则：

- `<100` 的 runtime 只在 `turn0` 跑一次
- `100-1000` 的 runtime 默认无限次触发
- `maxRunsPerSession` 按 session 单独计数
- `maxRunsPerTurn` 表示单 turn 上限
- 同一 turn 内多次运行必须由新的触发再次唤起

## 7. tools/

### 7.1 定位

`tools/` 是对 agent 暴露的正式能力合同。这里的 tool 会被框架转换成 function-calling 规格并注入 runtime。

### 7.2 目录规则

```text
runtimes/<runtime-id>/tools/
  roll-dice.js
  create-npc.py
```

规则：

- 一文件一个 tool
- 文件名建议与 tool id 一致
- 支持 `.js` / `.mjs` / `.py`

### 7.3 JS tool 示例

```javascript
export const tool = {
  id: "roll-dice",
  description: "Roll dice by formula and return structured result.",
  exported: true,
  inputSchema: {
    type: "object",
    properties: {
      formula: { type: "string" }
    },
    required: ["formula"]
  },
  outputSchema: {
    type: "object",
    properties: {
      formula: { type: "string" },
      total: { type: "integer" },
      rolls: {
        type: "array",
        items: { type: "integer" }
      }
    },
    required: ["formula", "total", "rolls"]
  },
  async execute(ctx) {
    return {
      formula: ctx.input.formula,
      total: 10,
      rolls: [6, 3, 1]
    };
  }
};
```

### 7.4 Python tool 示例

```python
from covel import tool

@tool(
    id="create-npc",
    description="Create an NPC draft in structured JSON.",
    exported=False,
    input_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string"}
        },
        "required": ["name"]
    },
    output_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "summary": {"type": "string"}
        },
        "required": ["name", "summary"]
    }
)
def execute(ctx):
    return {
        "name": ctx["input"]["name"],
        "summary": "A new NPC draft"
    }
```

### 7.5 共享规则

- 内置工具保留 `kernel:*` 命名空间
- 插件工具的完整限定名使用 `<pluginId>.<toolId>`
- 本地 tool 默认只给本 runtime 使用
- `exported: true` 才允许对外暴露
- 外部 runtime 必须在 `toolImports` 中显式声明依赖
- 框架 registry 负责解析、装配和路由

## 8. scripts/

### 8.1 定位

`scripts/` 是插件私有脚本层，用于复杂逻辑、数据处理、模板加工等。

### 8.2 调用方式

- 不直接默认注入 agent
- 统一通过 `kernel:exec_script` 调用
- 可返回 JSON 或 string
- 返回结果会被 trace 记录

### 8.3 设计原则

- `tools/` 是 agent 看到的能力接口
- `scripts/` 是底层实现资产
- 如果一个能力要稳定暴露给 agent 或其他插件，应优先用 `tools/`
- `tools/` 内部可以转而调用 `scripts/`

## 9. references/

`references/` 是按需加载的参考资料，不默认全量注入 prompt。

通过 `kernel:load_reference` 按需读取，适合：

- 世界观补充
- 规则手册
- 长篇 lore
- 大型静态数据表

## 10. 输出规格

### 10.1 基本原则

- 每个 runtime 都必须声明自己的 `output.schema.json`
- runtime 最终输出必须是结构化 JSON
- 即使模型表面上返回一段 string，也必须被规范化并校验为 JSON

### 10.2 Published Record Envelope

runtime 自己声明的是 `payload schema`。框架统一包一层固定 envelope：

```json
{
  "recordType": "runtime_result",
  "pluginId": "core-states",
  "runtimeId": "state-tracker",
  "sessionId": "session-123",
  "turnId": "turn-7",
  "runId": "run-456",
  "traceId": "trace-789",
  "status": "success",
  "timestamp": "2026-04-07T15:00:00.000Z",
  "locale": "zh-CN",
  "payload": {
    "updatedTables": ["core-states.character"],
    "summary": "主角获得了一把新武器。"
  }
}
```

状态建议：

- `success`
- `failed`
- `approval_denied`
- `skipped_condition`
- `skipped_limit`

## 11. 数据访问与所有权

### 11.1 Published Records

跨插件默认读取这层，不能直接读取对方底层 trace。

通过 `kernel:query_records` 查询：

- 某插件最近 N 次结果
- 某 runtime 历史结果
- 某状态的记录
- 某时间区间的记录

### 11.2 Live State Tables

通过 `kernel:query_tables` / `kernel:write_table` / `kernel:patch_table_schema` 访问。

规则：

- 表 owner 默认是创建它的插件
- 只有 owner 可以直接写表
- 其他插件只能读，或通过 owner 暴露的 tool 间接修改
- schema 变更允许发生在正式游戏阶段
- schema 变更一旦提交，立刻对本轮后续更低优先级 runtime 可见
- 同优先级并行 runtime 看不到这次变更

## 12. 配置系统

V1 只保留 `runtime-level settings`。

规则：

- 插件级没有单独的 settings 语义
- 前端可以按插件聚合展示多个 runtime 的 settings
- 修改 runtime setting 后，只影响后续新的运行
- 不影响已经在执行中的 runtime

## 13. 审批

### 13.1 基本规则

- 框架统一拦截 tool、script 和其他受控操作
- 特殊白名单中的内置插件 runtime 默认放行
- 非白名单插件默认需要用户授权

### 13.2 授权粒度

授权作用域固定为：

```text
session + plugin + tool
```

说明：

- 不是逐次弹窗
- 同一 session 内，对同一插件调用同一 tool，一次授权后持续有效
- 热重载后授权继续有效

## 14. i18n

规则：

- `displayName`、`description`、setting label 等用户可见元数据必须支持 i18n
- runtime prompt 中必须显式注入当前 locale
- runtime 最终自然语言内容必须使用当前 locale
- 结构化字段名不随 locale 改变

## 15. 测试

每个 runtime 都应支持独立测试。

推荐结构：

```text
runtimes/<runtime-id>/tests/
  unit/
  live/
```

建议覆盖：

- output schema 校验
- tool 输入输出校验
- script 返回值校验
- runtime 独立执行
- 真模型下的 live test

## 16. V1 不做的事情

以下内容不进入 V1 核心规格：

- 插件直接修改框架代码
- 插件直接读取底层 trace
- 插件直接写其他插件拥有的表
- 破坏性 schema 变更
- 任意 SQL / 原始数据库连接暴露给插件
- 插件直接加载其他插件代码
