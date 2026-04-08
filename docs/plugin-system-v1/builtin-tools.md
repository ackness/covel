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

### 兼容性变更白名单

V1 允许的兼容性修改：

| 操作 | 是否允许 | 说明 |
|------|----------|------|
| 新增可选字段 | ✅ | 不影响现有消费者 |
| 放宽 enum（增加新值） | ✅ | 现有值仍然有效 |
| 将 required 字段改为 optional | ⚠️ 有条件 | 必须提供 default 值，框架填充 |
| 放宽类型约束（如 int → number） | ✅ | 超集兼容 |
| 新增 required 字段 | ❌ | 会破坏现有数据 |
| 删除字段 | ❌ | 消费者可能依赖 |
| 缩小 enum（移除值） | ❌ | 现有数据可能包含被移除的值 |
| 改变字段类型（如 string → number） | ❌ | 不兼容 |
| 重命名字段 | ❌ | 等同于删除 + 新增 |

框架在 `patch_table_schema` 执行时必须自动校验变更是否属于白名单内操作，不合规则直接拒绝。

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
- 请求用户选择
- 等待某个前端回调

### 交互类型

| type | 说明 |
|------|------|
| `approval` | 请求审批某个受控操作 |
| `form` | 展示表单让用户填写 |
| `choice` | 展示选项让用户选择 |
| `confirm` | 展示确认对话框 |

### 建议参数

```json
{
  "type": "approval",
  "title": {
    "zh-CN": "允许插件调用外部工具",
    "en-US": "Allow plugin tool call"
  },
  "payload": {
    "pluginId": "third-party-search",
    "toolId": "web.search"
  },
  "timeoutMs": 300000
}
```

### 执行模型：suspend-and-resume

V1 采用 **runtime 挂起 → 回调恢复** 模型，而非 coroutine。

完整流程：

```text
1. runtime 执行过程中调用 kernel:request_interaction
2. 框架将当前 runtime 标记为 suspended
3. 框架记录挂起点上下文：
   - runtimeId
   - sessionId
   - turnId
   - runId
   - interactionId（唯一标识本次交互）
   - 已完成的 tool calls 和中间状态
4. 框架通知前端展示交互 UI
5. runtime 执行暂停，不占用执行资源
6. 用户在前端操作后，前端发送回调到 /api/sessions/:sessionId/approvals/callback
7. 框架触发 approval.callback trigger
8. 框架恢复 runtime，将用户回复注入为 tool call 的返回值
9. runtime 从挂起点继续执行
```

### 挂起上下文

```typescript
interface SuspendedRuntimeContext {
  interactionId: string;
  runtimeId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  suspendedAt: string;       // ISO timestamp
  interactionType: string;   // approval | form | choice | confirm
  pendingMessages: unknown[]; // LLM 对话历史快照
  pendingToolCalls: unknown[]; // 已完成但未提交的 tool call 结果
  timeoutMs: number;
}
```

### 超时策略

- 默认超时 `300000ms`（5 分钟），可通过参数覆盖
- 超时后框架自动将 runtime 标记为 `failed`，生成 published record：
  - `status: "failed"`
  - `failureReason: "interaction_timeout"`
- 已完成的中间写操作不提交（遵循 runtime 原子提交规则）

### 与 approval-callback trigger 的关系

- `kernel:request_interaction` 是 runtime **主动发起**交互的工具
- `approval-callback` trigger 是框架**自动拦截**受控操作后产生的审批流
- 两者回调路径相同（`/api/sessions/:sessionId/approvals/callback`），但来源不同：
  - `request_interaction` → runtime 显式调用
  - `approval-callback` → 框架自动拦截

### 约束

- 一个 runtime 同一时刻只能有一个 pending interaction
- 挂起期间不阻塞其他 runtime 的调度
- 挂起的 runtime 不计入同优先级并行执行组
- 回调恢复后的 runtime 独立执行，不重新进入原优先级分组

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
