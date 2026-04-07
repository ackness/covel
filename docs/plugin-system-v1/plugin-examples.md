# 插件分类与示例

时间：2026-04-07  
状态：草案

## 插件分类

### `pluginType = "core-plugin"`

- 默认开启
- 玩家不能主动关闭
- 与普通插件没有读写特权差异

### `pluginType = "plugin"`

- 玩家可启用 / 禁用
- 负责扩展玩法或特殊能力

## 核心插件建议收口

V1 建议先收成 4 个核心插件：

| 插件 | 职责 |
|------|------|
| `core-states` | 动态表结构、状态快照、共享表 owner |
| `core-narrator` | 叙事与引导 |
| `core-session` | pre-game、开局、审批回调编排 |
| `core-memory` | 历史压缩与检索 |

## 示例 1：core-states

### 插件结构

```text
core-states/
  plugin.json
  PLUGIN.md
  runtimes/
    schema-builder/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
      tools/
      scripts/
    data-initializer/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
    state-tracker/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
      tools/
```

### 典型 runtime

| runtime | priority | trigger | 说明 |
|---------|----------|---------|------|
| `schema-builder` | 30 | `pre-game-once` | 创建动态表结构 |
| `data-initializer` | 60 | `pre-game-once` | 初始化 NPC / 世界状态 |
| `state-tracker` | 550 | `turn` | 从叙事中提取状态变化 |

### 使用的系统工具

- `kernel:query_tables`
- `kernel:write_table`
- `kernel:patch_table_schema`
- `kernel:emit_domain_event`

### 对外导出的 tool 示例

- `core-states.get-schema`
- `core-states.update-character`
- `core-states.get-world`

## 示例 2：core-narrator

### 典型 runtime

| runtime | priority | trigger | 说明 |
|---------|----------|---------|------|
| `persona` | 150 | `turn` | 提供叙事风格约束 |
| `narrator` | 500 | `turn` | 主叙事 runtime |
| `guide` | 650 | `turn` | 生成引导 / 选项 |

### 关键点

- `persona`、`narrator`、`guide` 虽然属于同一插件，但仍然是独立 runtime
- 低优先级的 `guide` 可以读取更高优先级 `narrator` 已经发布的记录
- 同优先级 runtime 不共享本轮未提交结果

## 示例 3：core-session

### 典型 runtime

| runtime | priority | trigger | 说明 |
|---------|----------|---------|------|
| `start-button` | 100 | `manual` | 处理开始游戏动作 |
| `approval-dispatch` | 300 | `approval-callback` | 处理审批后的继续执行 |
| `session-orchestrator` | 800 | `event` | 管理 session 生命周期事件 |

### 关键点

- `100` 是开始游戏边界，不只是普通优先级
- `pre-game` 结束后才进入正式 turn
- 审批返回也视作一种独立 trigger

## 示例 4：dice-roll 扩展插件

### 典型 runtime

```json
{
  "id": "dice-roll",
  "priority": 620,
  "trigger": { "type": "manual", "action": "dice.roll" },
  "systemTools": [
    "kernel:write_table",
    "kernel:query_records"
  ],
  "toolImports": []
}
```

### 运行过程

1. agent 调用本 runtime 下的 `roll-dice` tool
2. tool 内部可再调用 `kernel:exec_script` 做复杂计算
3. runtime 结束后发布一条标准化记录
4. 框架统一补齐 envelope，例如：

```json
{
  "recordType": "runtime_result",
  "pluginId": "dice-roll",
  "runtimeId": "dice-roll",
  "runId": "run-123",
  "status": "success",
  "payload": {
    "results": {
      "3d6": [6, 3, 1]
    }
  }
}
```

5. 其他插件通过 `kernel:query_records` 读取该记录

## 示例 5：共享表 owner 模型

假设 `core-states` 拥有：

- `core-states.character`
- `core-states.world`
- `core-states.item`

其他插件：

- 可以读这些表
- 不能直接写这些表
- 如果要改角色属性，必须调用 `core-states.update-character`

这个设计保证：

- 表 ownership 清晰
- 同优先级并行时写冲突大幅减少
- 动态 schema 的演进点也集中在 owner 插件中

## 示例 6：异步图像工作流插件

这是第二个参考插件：一个真正的多 runtime、手动触发、前后端联动工作流插件。

### 插件结构

```text
image-workflow-demo/
  plugin.json
  PLUGIN.md
  runtimes/
    prompt-optimizer/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
    image-generator/
      runtime.json
      llm.toml
      instructions.md
      output.schema.json
```

### 插件级 action

```json
{
  "id": "generate-story-image",
  "uiSlot": "message.quick-actions",
  "async": true,
  "workflow": {
    "steps": ["prompt-optimizer", "image-generator"],
    "resultRuntimeId": "image-generator"
  }
}
```

前端行为：

- 在消息快捷按钮区渲染一个统一按钮
- 玩家点击一次后，框架启动异步 workflow
- 前端显示阶段状态：
  - `Prompt 优化中`
  - `图片生成中`
  - `完成`

### runtime 设计

| runtime | priority | trigger | 说明 |
|---------|----------|---------|------|
| `prompt-optimizer` | 710 | `manual` | 收集当前上下文，生成结构化图片 prompt |
| `image-generator` | 720 | `manual` | 接收上一 runtime 的显式输入，用图片模型生成图片 |

### 关键点

- 不是靠事件链串起来，而是一次 action 启动一条标准 workflow
- `image-generator` 直接拿到 `prompt-optimizer` 的结构化输出
- 两个 runtime 各自产生一条 published record
- 前端主界面只显示图片，详细 prompt / 模型参数 / 错误信息在 debug 中查看
