# Phase 5: 状态管理、事件系统与持久化

> 预计工作量：5-7 天
> 前置依赖：Phase 1（类型系统）、Phase 4（工具系统，update-state/emit-event 工具依赖本阶段）
> 交付物：动态状态表、变更历史、事件总线、消息路由、持久化抽象层、Pre-Game 阶段

---

## 5.1 目标

实现游戏状态的完整生命周期管理：动态表创建、状态读写、变更历史追踪、事件驱动通信、多后端持久化。

## 5.2 动态状态表系统

### 5.2.1 设计理念

游戏世界的状态表结构因世界观而异，不是固定 schema。框架提供动态 CRUD 能力，类似一个轻量的 runtime schema registry。

### 5.2.2 状态管理器接口

```typescript
// @covel/state

export interface StateManager {
  // === 表操作 ===
  
  /** 创建状态表（Pre-Game 阶段调用） */
  createTable(sessionId: string, schema: StateTableSchema): Promise<void>;
  
  /** 获取所有表的 schema */
  getTableSchemas(sessionId: string): Promise<StateTableSchema[]>;
  
  /** 删除表（session 结束时） */
  dropTable(sessionId: string, tableName: string): Promise<void>;
  
  // === 字段读写 ===
  
  /** 读取字段当前值 */
  getValue(sessionId: string, table: string, field: string): Promise<unknown>;
  
  /** 读取整张表的当前状态 */
  getTableSnapshot(sessionId: string, table: string): Promise<Record<string, unknown>>;
  
  /** 更新字段值（产生变更记录） */
  updateValue(
    sessionId: string,
    table: string,
    field: string,
    value: unknown,
    metadata: StateChangeMetadata
  ): Promise<void>;
  
  /** 批量更新（同一个 Runtime 的多次写入合并为一次事务） */
  batchUpdate(
    sessionId: string,
    updates: StateUpdateBatch[]
  ): Promise<void>;
  
  // === 变更历史 ===
  
  /** 获取字段的变更历史 */
  getChangeLog(
    sessionId: string,
    table: string,
    field: string,
    options?: { limit?: number; since?: string }
  ): Promise<StateChangeEntry[]>;
  
  /** 获取某个 Turn 内的所有变更 */
  getChangesByTurn(sessionId: string, turnId: string): Promise<StateField[]>;
  
  // === 查询 ===
  
  /** 通用查询（支持简单过滤） */
  query(sessionId: string, table: string, filter?: StateFilter): Promise<Record<string, unknown>[]>;
}

export interface StateChangeMetadata {
  changedBy: string; // pluginId/runtimeId
  turnId: string;
  reason?: string;
}

export interface StateUpdateBatch {
  table: string;
  field: string;
  value: unknown;
  reason?: string;
}

export interface StateFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: unknown;
}
```

### 5.2.3 变更历史与滑动窗口

```typescript
export interface StateHistoryConfig {
  /** 每个字段最多保留的变更记录数 */
  windowSize: number; // 默认 100
  /** session 初始值永久保留 */
  keepSessionBoundary: boolean; // 默认 true
}

/**
 * 滑动窗口策略：
 * 1. 每次写入新记录时检查窗口大小
 * 2. 超过 windowSize 时移除最旧记录
 * 3. session 边界值（初始值）永久保留，不受窗口限制
 * 4. 被移除的记录写入归档日志（保证不丢失）
 */
```

### 5.2.4 写冲突收集

状态管理器在 Turn 执行期间收集所有写操作，Turn 结束时检测冲突：

```typescript
export interface WriteCollector {
  /** Turn 开始时创建收集器 */
  startTurn(turnId: string): void;
  
  /** 记录一次写操作（不立即写入存储） */
  recordWrite(write: PendingWrite): void;
  
  /** Turn 结束时检测冲突并提交 */
  commitTurn(turnId: string): Promise<CommitResult>;
}

export interface PendingWrite {
  table: string;
  field: string;
  newValue: unknown;
  pluginId: string;
  runtimeId: string;
  priority: number;
  reason?: string;
}

export interface CommitResult {
  /** 无冲突的写入（已提交） */
  committed: PendingWrite[];
  /** 检测到的写冲突（待 Audit 裁决） */
  conflicts: WriteConflict[];
}
```

## 5.3 事件总线与消息路由

### 5.3.1 事件总线

```typescript
// @covel/events

export interface EventBus {
  /** 发布事件 */
  emit(message: CovelMessage): Promise<void>;
  
  /** 订阅 topic（精确匹配或通配符） */
  on(topic: string, handler: EventHandler): () => void;
  
  /** 一次性订阅 */
  once(topic: string, handler: EventHandler): () => void;
  
  /** 获取待处理的事件（供 Trigger Router 使用） */
  getPendingEvents(sessionId: string): CovelMessage[];
  
  /** 消费事件（标记为已处理） */
  acknowledge(messageId: string): void;
  
  /** 清理 session 的所有事件 */
  clearSession(sessionId: string): void;
}

export type EventHandler = (message: CovelMessage) => void | Promise<void>;
```

### 5.3.2 消息路由

```typescript
export interface MessageRouter {
  /**
   * 路由消息到正确的目标。
   * 
   * type: "message" → 追加到目标 Runtime 的上下文
   * type: "event"   → 触发订阅该 topic 的所有回调
   * type: "callback" → 触发指定 Runtime 作为回调执行
   */
  route(message: CovelMessage): Promise<void>;
}
```

### 5.3.3 Runtime 作为事件回调

当 Runtime 配置 `trigger.type: event` 并指定 `topic` 时：

```typescript
/**
 * 事件回调的两种模式：
 * 
 * 1. 轻量回调（local tool 函数）
 *    → 直接执行 JS/TS 函数，不涉及 LLM
 *    → 适合简单的数据处理、状态更新
 * 
 * 2. 完整 Runtime 回调
 *    → 触发完整的 LLM Agent 流程
 *    → 有 prompt、tools、structured output
 *    → 适合需要 LLM 推理的复杂处理
 */
```

### 5.3.4 事件持久化

所有事件记录到持久化存储：

```typescript
export interface EventLog {
  /** 记录事件 */
  append(message: CovelMessage): Promise<void>;
  
  /** 查询事件历史 */
  query(params: {
    sessionId: string;
    topic?: string;
    since?: string;
    limit?: number;
  }): Promise<CovelMessage[]>;
}
```

## 5.4 持久化抽象层

### 5.4.1 统一存储接口

```typescript
// @covel/store

export interface DataStore {
  // === Session ===
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, patch: Partial<Session>): Promise<void>;
  listSessions(): Promise<Session[]>;
  
  // === Runtime Results ===
  saveRuntimeResult(result: RuntimeResult): Promise<void>;
  getRuntimeResult(turnId: string, pluginId: string, runtimeId: string): Promise<RuntimeResult | null>;
  getRuntimeResults(turnId: string): Promise<RuntimeResult[]>;
  getRecentResults(pluginId: string, runtimeId: string, limit: number): Promise<RuntimeResult[]>;
  
  // === Tool Call Records ===
  saveToolCall(record: ToolCallRecord): Promise<void>;
  getToolCalls(turnId: string): Promise<ToolCallRecord[]>;
  
  // === State Tables ===
  createStateTable(sessionId: string, schema: StateTableSchema): Promise<void>;
  getStateValue(sessionId: string, table: string, field: string): Promise<unknown>;
  setStateValue(sessionId: string, table: string, field: string, value: unknown, metadata: StateChangeMetadata): Promise<void>;
  getStateChangeLog(sessionId: string, table: string, field: string): Promise<StateChangeEntry[]>;
  getTableSnapshot(sessionId: string, table: string): Promise<Record<string, unknown>>;
  
  // === Events ===
  saveEvent(message: CovelMessage): Promise<void>;
  getEvents(sessionId: string, options?: { topic?: string; limit?: number }): Promise<CovelMessage[]>;
  
  // === Approval Records ===
  saveApproval(record: ApprovalRecord): Promise<void>;
  getSessionApprovals(sessionId: string): Promise<ApprovalRecord[]>;
  
  // === Turn Log ===
  saveTurnResult(result: TurnResult): Promise<void>;
  getTurnResult(turnId: string): Promise<TurnResult | null>;
  getTurnHistory(sessionId: string, limit?: number): Promise<TurnResult[]>;
  
  // === Plugin Config ===
  savePluginConfig(pluginId: string, config: Record<string, unknown>): Promise<void>;
  getPluginConfig(pluginId: string): Promise<Record<string, unknown> | null>;
}
```

### 5.4.2 存储后端实现

| 后端 | 用途 | 实现方式 |
|------|------|----------|
| `MemoryStore` | 开发/测试 | 内存 Map/Array |
| `IdbStore` | 浏览器 T1/T2 部署 | IndexedDB（via `idb`） |
| `PgStore` | 生产 T3 部署 | PostgreSQL（via Drizzle ORM） |

所有后端实现 `DataStore` 接口，通过 contract tests 确保行为一致。

### 5.4.3 数据库 Schema（PgStore）

```sql
-- Session
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT,
  phase TEXT NOT NULL DEFAULT 'pre-game',
  turn_count INTEGER NOT NULL DEFAULT 0,
  active_plugins JSONB NOT NULL DEFAULT '[]',
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runtime Results
CREATE TABLE runtime_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output JSONB,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  duration_ms INTEGER,
  token_usage JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_runtime_results_turn ON runtime_results(turn_id);
CREATE INDEX idx_runtime_results_lookup ON runtime_results(plugin_id, runtime_id);

-- State Tables
CREATE TABLE state_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  table_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, table_name, field_name)
);

-- State Change History
CREATE TABLE state_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value JSONB,
  changed_by TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_state_changes_field ON state_changes(session_id, table_name, field_name);

-- Tool Call Records
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  input JSONB NOT NULL,
  output JSONB,
  duration_ms INTEGER,
  approval_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id);

-- Events
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  target_runtime TEXT,
  turn_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_session_topic ON events(session_id, topic);

-- Turn Results
CREATE TABLE turn_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL UNIQUE,
  runtime_results JSONB NOT NULL,
  conflicts JSONB,
  audit_result JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Approval Records
CREATE TABLE approval_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- State Table Schemas
CREATE TABLE state_table_schemas (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  schema JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, table_name)
);
```

## 5.5 Pre-Game 阶段

### 5.5.1 执行流程

```
玩家点击"开始游戏"
  → 创建 Session（phase = 'pre-game'）
  → 加载世界观文件中的预定义状态表 schema
  → 执行 priority 0-99 的 Runtime（Pre-Game 阶段）
      → 初始化状态表
      → 创建初始角色数据
      → 验证插件依赖
  → Session.phase = 'playing'
  → 等待玩家第一次输入
```

### 5.5.2 世界观预定义状态

从世界观文件（`references/` 或 `world.yaml`）加载预定义的状态表结构：

```typescript
export interface WorldStateLoader {
  /**
   * 从世界观文件加载预定义的状态表 schema。
   * 支持 YAML frontmatter 中的 type: state-schema 格式。
   */
  loadPredefinedSchemas(worldDir: string): Promise<StateTableSchema[]>;
}
```

## 5.6 存储分层

```
Session 级别（游戏过程中持续写入）
  ├── runtime_results      每个 Turn 每个 Runtime 的输出
  ├── tool_calls           每次工具调用记录
  ├── state_entries        动态表的当前状态
  ├── state_changes        状态变更历史
  ├── events               事件收发历史
  ├── turn_results         每个 Turn 的执行摘要
  └── approval_records     审批记录

全局级别（跨 session 复用）
  ├── state_table_schemas  世界观预定义的状态表结构
  └── plugin_configs       插件配置覆盖
```

## 5.7 验收标准

- [ ] 动态状态表可创建、读写、删除
- [ ] 状态变更历史正确记录，滑动窗口策略生效
- [ ] 事件总线可发布/订阅/确认事件
- [ ] 消息路由正确处理三种消息类型
- [ ] MemoryStore 实现完整且通过 contract tests
- [ ] PgStore 实现完整且通过 contract tests
- [ ] Pre-Game 阶段执行流程正确
- [ ] 世界观预定义状态表可正确加载
- [ ] 写冲突收集器可正确检测并发写入冲突
- [ ] 单元测试 + 集成测试覆盖率 ≥ 80%
