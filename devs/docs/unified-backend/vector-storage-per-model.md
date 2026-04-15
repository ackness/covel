# 向量存储 · 按 Embedding 模型隔离

## 设计目标

> **每个 embedding model 拥有独立的物理向量表。切换模型等于换表，旧表原地保留。会话启动后锁定模型，直到结束不可变。所有向量数据按 session 隔离，和现有 `plugin_data` 的隔离语义一致。用户对切换过程无感知。**

## 为什么不按维度分表

最初方案是 `vec_memory_f{dim}`（如 `vec_memory_f1536`）。被放弃的原因：

- 两个不同模型可能共享同一维度（例：OpenAI `text-embedding-3-small` 和某国产 1536 维模型），向量空间不兼容但挤在同一张表里会污染检索结果。
- 维度只是模型的一个属性，不是身份；以属性为分区键是错的。
- 无法表达"切回旧模型继承数据"的语义。

## 新设计：按 Model 身份建表

### 1. Model 身份定义

**组合键 = `provider + model_name + dim`**，三元组唯一标识一个向量空间。

- `provider`: `openai` / `ollama` / `voyage` / ...
- `model_name`: `text-embedding-3-small` / `nomic-embed-text` / ...
- `dim`: 固定维度（1536 / 768 / 3072 / ...）

**不包含 baseUrl**：Azure 代理、自建网关、官方 API 只要 provider + model_name 一致，就视为同一模型，共享存储。用户换代理不掉数据。

**规范化**：`model_id = "${provider}/${model_name}"`（例：`"openai/text-embedding-3-small"`）。dim 作为独立列用于健康检查。

## 2. `vector_models` 注册表

SQLite 与 PG 各一份，schema 完全一致：

```sql
CREATE TABLE vector_models (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- PG: SERIAL
  model_id        TEXT NOT NULL,                      -- "openai/text-embedding-3-small"
  provider        TEXT NOT NULL,                      -- "openai"
  model_name      TEXT NOT NULL,                      -- "text-embedding-3-small"
  dim             INTEGER NOT NULL,                   -- 1536
  table_name      TEXT NOT NULL,                      -- "vec_mem_m1"
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  UNIQUE (model_id, dim)                              -- dim 作为安全校验
);
```

- **自增 id 派生物理表名**：`vec_mem_m{id}`，稳定、短、SQL 安全，不管 model_id 多长多脏。
- **`UNIQUE (model_id, dim)`**：model_id 相同但 dim 不同时（provider 偷偷改了维度）会报错，安全网。

## 3. 物理向量表

### SQLite（sqlite-vec）

```sql
-- 向量虚表（vec0 只能存 embedding，不能塞 metadata）
CREATE VIRTUAL TABLE vec_mem_m{id} USING vec0(
  embedding float[{dim}]
);

-- 旁路 metadata 表：通过 rowid 关联
CREATE TABLE vec_mem_m{id}_meta (
  rowid       INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  plugin_id   TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  payload     TEXT,           -- 可选 JSON 扩展字段
  UNIQUE (session_id, plugin_id, namespace, key)
);

CREATE INDEX idx_vec_mem_m{id}_meta_session
  ON vec_mem_m{id}_meta(session_id, plugin_id, namespace);
```

- **写入**：先插 meta 拿 rowid，再向 vec0 插入同 rowid 的 embedding。事务保证一致。
- **查询**：`SELECT rowid, distance FROM vec_mem_m{id} WHERE embedding MATCH ? ORDER BY distance LIMIT k` → JOIN meta 过滤 `session_id`

### PostgreSQL（pgvector）

```sql
CREATE TABLE vec_mem_m{id} (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  plugin_id   TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  embedding   vector({dim}) NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, plugin_id, namespace, key)
);

CREATE INDEX idx_vec_mem_m{id}_hnsw
  ON vec_mem_m{id}
  USING hnsw (embedding vector_l2_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_vec_mem_m{id}_session
  ON vec_mem_m{id} (session_id, plugin_id, namespace);
```

- 维度在 `CREATE TABLE` 时固化到 `vector({dim})`，后续插入会被 PG 自己校验。
- HNSW 索引参数预设保守值，后期可按模型单独调优。

## 4. `sessions` 表扩展

```sql
ALTER TABLE sessions ADD COLUMN embedding_model_id INTEGER;
  -- 外键 → vector_models.id；NULL 表示 RAG 禁用
ALTER TABLE sessions ADD COLUMN embedding_locked_at INTEGER;
  -- 锁定时间戳，null 表示未锁定
```

- 写一次 migration；迁移工具处理旧数据（全部置 NULL）。
- store 层强制：**任何代码路径不允许 UPDATE 这两列**（加 trigger 或 store 侧校验）。

## 运行期算法

### 会话创建

```typescript
// 伪代码
function createSession(world: World): Session {
  const session = insertSessionRow(world);

  const embeddingConfig = resolveEmbeddingSlot(llmConfig);
  if (!embeddingConfig) {
    return session;
  }

  const identity = normalizeModelIdentity(embeddingConfig);
  const model = upsertVectorModel(identity);
  if (model.created) {
    createPhysicalVectorTable(model);
  }

  updateSessionEmbeddingLock(session.id, model.id);
  return session;
}
```

### 会话恢复 / 回合执行

```typescript
function beginTurn(sessionId: string): TurnContext {
  const session = getSession(sessionId);
  const lockedModel = session.embeddingModelId
    ? getVectorModel(session.embeddingModelId)
    : null;

  const currentConfig = resolveEmbeddingSlot(llmConfig);
  if (lockedModel && currentConfig && lockedModel.modelId !== currentConfig.modelId) {
    emitTraceInfo("embedding.model.diverged", {
      locked: lockedModel.modelId,
      current: currentConfig.modelId,
      using: "locked",
    });
  }

  return buildTurnContext({ session, vectorTarget: lockedModel });
}
```

### 向量写入与查询（透明路由）

```typescript
interface VectorStoreCapability {
  upsertVector(sessionId: string, pluginId: string, namespace: string, key: string, embedding: Float32Array): Promise<void>;
  searchVectors(sessionId: string, query: VectorQuery): Promise<VectorHit[]>;
  deleteVectors(sessionId: string, filter: VectorFilter): Promise<number>;
}
```

实现层内部：

```typescript
async upsertVector(sessionId, pluginId, namespace, key, embedding) {
  const target = this.resolveVectorTarget(sessionId);
  if (!target) throw new Error("Session has no embedding model locked");
  if (embedding.length !== target.dim) throw new Error("dim mismatch");
  await this.writeToPhysicalTable(target.tableName, {
    sessionId, pluginId, namespace, key, embedding
  });
}
```

`resolveVectorTarget(sessionId)` 是新增的内部辅助，缓存 `(session_id → tableName, dim)` 映射，避免每次写入都 JOIN。

## 跨场景验证用例

| 场景 | 期望行为 |
|---|---|
| 新 session 用 Model A | 新建 `vec_mem_m1`，注册表新增一行 |
| 同时运行两个 session，都用 Model A | 共享 `vec_mem_m1`，按 `session_id` 隔离数据 |
| 用户切换到 Model B，新开 session | 新建 `vec_mem_m2`，Model A 的表完全不动 |
| 用户切回 Model A，新开 session | 复用 `vec_mem_m1`，继承历史数据 |
| Resume 一个 Model A 的旧 session | 依然走 `vec_mem_m1`，哪怕当前配置是 Model B |
| 配置指向不存在的 embedding 模型 | 创建失败 fail fast；现有 session 不受影响 |
| 配置删除了 embedding slot | 新 session RAG 禁用（`embedding_model_id = NULL`），旧 session 继续用原锁定 |
| Provider 偷偷把 model_name 的维度从 1536 改到 2048 | `UNIQUE (model_id, dim)` 触发，启动报错提示 |

全部写入 `packages/store/tests/vector-store-per-model.test.ts`，跑两遍（SQLite + PG）。

## 迁移与旧数据处理

当前 `sqlite-vector.ts` 的 `vec_memory_f{dim}` 是旧 schema，而且 runtime 还没开始调用 `searchVectors`（之前的调研报告已确认）——**无存量数据**。

直接在 Phase 0 里：

1. 添加一个 `DROP TABLE IF EXISTS vec_memory_f*` 的一次性清理（只在 dev，production 还没人在用）
2. 新建 `vector_models` + `sessions.embedding_model_id` / `embedding_locked_at` 列
3. 第一次启动时自动完成

不需要数据迁移脚本。

## 未来扩展点

- **多 slot 支持**：目前一 session 一把锁。如果未来某个插件要求与主 embedding model 不同的向量空间（例如专门的代码语义 embedding），可以把 `sessions.embedding_model_id` 扩成 `session_embedding_locks (session_id, purpose, model_id)`。现在的 schema 不排斥这个演化。
- **物理表 GC**：`scripts/prune-vector-tables.ts` 扫 `vector_models` 找没被任何 session 引用的表并回收——**暂缓实现**。
- **跨物理表聚合查询**：短期不需要。一 session 一表一目了然。
