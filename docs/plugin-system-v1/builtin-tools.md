# 框架内置工具清单（Built-in Tools）

时间：2026-04-07  
状态：草案

## 设计原则

V1 的内置工具只提供**最小可组合的系统能力**。

- 框架负责基础设施，不负责领域玩法
- 插件负责具体玩法、世界规则和业务工具
- 内置工具保持少而稳，避免再次演化成“大而全 kernel API”

## V1 最小集合

| 工具 ID | 用途 |
|---------|------|
| `kernel:query_records` | 查询标准化发布记录 |
| `kernel:query_tables` | 查询 live state tables 的快照、历史与 diff |
| `kernel:write_table` | 对当前插件拥有的表做写入 |
| `kernel:patch_table_schema` | 对当前插件拥有的表做兼容性 schema 变更 |
| `kernel:emit_domain_event` | 追加业务事件 |
| `kernel:exec_script` | 执行当前 runtime 的私有脚本 |
| `kernel:load_reference` | 按需加载 references 内容 |
| `kernel:request_interaction` | 发起统一前端 / HITL 交互 |

## 1. kernel:query_records

读取框架维护的标准化发布记录。

### 用途

- 读取其他插件最近的 runtime 结果
- 按 runtime 查看历史结果
- 读取失败 / 被拒绝 / skipped 的记录
- 读取 domain events 和 approval records

### 建议参数

```json
{
  "pluginId": "core-states",
  "runtimeId": "state-tracker",
  "status": ["success", "failed"],
  "recordType": "runtime_result",
  "limit": 20,
  "cursor": null
}
```

### 约束

- 插件读到的是**框架标准化后的发布记录**
- 不是底层 trace 原始数据

## 2. kernel:query_tables

读取 live state tables。

### 视图模式

- `latest`：最新快照
- `history`：历史版本
- `diff`：两个版本之间的差异

### 建议参数

```json
{
  "mode": "latest",
  "table": "core-states.character",
  "filters": {
    "characterId": "hero"
  },
  "limit": 10
}
```

### 约束

- 读取范围必须命中 runtime 在 `tableAccess.read` 中声明的表名或模式

## 3. kernel:write_table

对当前插件拥有的表执行写入。

### 支持动作

- `insert`
- `update`
- `upsert`
- `delete`

### 建议参数

```json
{
  "action": "upsert",
  "table": "dice-roll.results",
  "key": "run-123",
  "data": {
    "formula": "3d6",
    "rolls": [6, 3, 1],
    "total": 10
  }
}
```

### 约束

- 默认只能写 owner 为当前插件的表
- 写入会进入完整历史记录
- 默认读取只看到最新快照

## 4. kernel:patch_table_schema

修改当前插件拥有表的 schema。

### 用途

- pre-game 动态创建表结构
- 运行中兼容性扩展字段
- 放宽字段约束

### 约束

- V1 只允许兼容性修改
- 每次修改都必须记录：
  - 变更前 schema
  - 变更后 schema
  - pluginId / runtimeId / runId
  - 时间戳

## 5. kernel:emit_domain_event

写入业务事件。

### 用途

- `quest.completed`
- `combat.attack`
- `location.changed`
- `inventory.item_acquired`

### 约束

- 业务事件和调度 trigger 事件不是一回事
- 该调用进入完整 trace
- 事件本身也要形成可查询记录

## 6. kernel:exec_script

统一执行当前 runtime `scripts/` 目录下的脚本。

### 用途

- 复杂计算
- 公式求值
- 数据整理
- 模板加工

### 建议参数

```json
{
  "script": "roll_luck.py",
  "args": {
    "formula": "3d6"
  }
}
```

### 约束

- 只允许执行当前 runtime 目录下的脚本
- 脚本返回值必须可规范化为 JSON 或 string
- 执行结果进入完整 trace
- 如果 tool 需要稳定暴露给 agent 或其他插件，优先使用 `tools/`，不要滥用 `exec_script`

## 7. kernel:load_reference

按需加载 `references/` 内容。

### 用途

- 长篇 lore
- 规则手册
- NPC 设定档
- 大型数据表

### 约束

- 不默认全量注入 prompt
- 读取内容进入 trace

## 8. kernel:request_interaction

统一前端 / human-in-the-loop 交互入口。

### 用途

- 请求审批
- 展示表单
- 请求继续执行
- 等待某个前端回调

### 建议参数

```json
{
  "type": "approval",
  "title": "Allow plugin tool call",
  "payload": {
    "pluginId": "third-party-search",
    "toolId": "web.search"
  }
}
```

## 不进入 V1 内置工具的能力

以下能力不作为 V1 内置工具暴露：

- 原始 SQL / 原始数据库连接
- 直接读取底层 trace
- 直接修改其他插件拥有的表
- 直接加载其他插件脚本
- 大量领域型工具，例如：
  - 战斗解析
  - NPC 生成
  - 图像生成
  - 任务管理
  - 记忆压缩

这些都应该作为插件自己的 `tools/` 实现。
