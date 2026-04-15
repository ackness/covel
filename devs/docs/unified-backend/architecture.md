# 统一后端数据层 · 整体架构

## 分层结构

```
┌────────────────────────────────────────────────────────────┐
│  Clients                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │  web-v2    │  │  Electron  │  │    CLI     │            │
│  │  (React)   │  │  (future)  │  │  (future)  │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        │               │               │                   │
│        └───────────────┴───────────────┘                   │
│                        │                                   │
│                        ▼                                   │
│              ┌──────────────────┐                          │
│              │ @covel/api-client│  ← 类型化 API 门面         │
│              │  + Transport 抽象 │                          │
│              └─────────┬────────┘                          │
└────────────────────────┼───────────────────────────────────┘
                         │ HTTP / SSE (or future IPC)
┌────────────────────────┼───────────────────────────────────┐
│  Server (apps/server)  │                                   │
│                        ▼                                   │
│              ┌──────────────────┐                          │
│              │  Hono routes     │                          │
│              │  /api/*          │                          │
│              └─────────┬────────┘                          │
│                        │                                   │
│                        ▼                                   │
│              ┌──────────────────┐                          │
│              │ bootstrapApi()   │                          │
│              │  DI container    │                          │
│              └─────────┬────────┘                          │
│                        │                                   │
└────────────────────────┼───────────────────────────────────┘
                         │
┌────────────────────────┼───────────────────────────────────┐
│  Kernel & Packages     │                                   │
│                        ▼                                   │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐            │
│  │ runtime  │  │ ai-provider│  │ plugin-loader│            │
│  └────┬─────┘  └─────┬──────┘  └──────┬───────┘            │
│       │              │                │                    │
│       └──────────────┴────────────────┘                    │
│                      │                                      │
│                      ▼                                      │
│            ┌──────────────────┐                             │
│            │  @covel/store    │                             │
│            │  DataStore IFace │                             │
│            │  + VectorCapab.  │                             │
│            └─────────┬────────┘                             │
└──────────────────────┼──────────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
  ┌─────────────┐              ┌─────────────┐
  │ SqliteStore │              │  PgStore    │
  │ better-sql3 │              │ postgres.js │
  │ + sqlite-vec│              │ + pgvector  │
  └─────────────┘              └─────────────┘
  Solo / Self-host             Team / Cloud
```

## 两档部署形态

### 档位 A · Solo / Self-host

- **目标用户**：个人玩家、离线创作、本地研究、开发者调试
- **运行方式**：单二进制 + 单 `.db` 文件，零外部依赖（除了 `sqlite-vec` 的 native addon）
- **环境变量**：
  ```bash
  STORE_BACKEND=sqlite   # 默认值，可省略
  SQLITE_PATH=./data/covel.db
  ```
- **向量能力**：启动时 eager load `sqlite-vec`，失败 fail fast（因为 RAG 是默认插件）
- **并发**：SQLite 单写入者，适合 1-2 个玩家同时游玩

### 档位 B · Team / Cloud

- **目标用户**：多人共享世界、云部署、重度 RAG / 长会话
- **运行方式**：`docker-compose up` 拉起 `pgvector/pgvector:pg17` + 应用容器
- **环境变量**：
  ```bash
  STORE_BACKEND=pg
  DATABASE_URL=postgresql://covel:xxx@db:5432/covel
  ```
- **向量能力**：启动时自动 `CREATE EXTENSION IF NOT EXISTS vector`，失败 fail fast
- **并发**：`postgres.js` 连接池，适合多玩家同时在线

### 档位切换（SQLite → PG）

通过 `scripts/migrate-store.ts` 一次性导出导入：

- 走 `DataStore` 接口遍历全部实体，**不直接 dump SQL**
- 元数据先迁，向量表默认**跳过**（让目标 backend 懒重建，维度对齐更安全）
- 迁移后校验双方 contract 测试通过

## 模块职责划分

| 模块 | 职责 | 本次变更 |
|---|---|---|
| `@covel/store` | `DataStore` 接口 + 三后端实现 + contract 测试 | ✳️ 新增 `vector_models` 注册表；重写 `sqlite-vector.ts` / 实现 `pg-vector.ts` 为"模型路由器 + 物理表 CRUD"两层 |
| `@covel/shared` | 纯类型 + Zod schema | ➕ 新增 embedding 相关类型：`EmbeddingModelIdentity`、`SessionEmbeddingLock` |
| `@covel/ai-provider` | LLM / embedding gateway | ➕ `gateway.embed()` 对外暴露；新增 `embedding` slot 解析 |
| `@covel/api-client` | **新包**，类型化 HTTP/SSE 门面 | 🆕 从零构建 |
| `apps/server` | Hono 路由、bootstrap、DI | ✳️ 启动期检查扩展 + 预热 `sqlite-vec`；`/api/sessions/:id` 返回 embedding lock 信息 |
| `apps/web-v2` | React 前端 | ✳️ `services/api.ts` 改为薄壳，全量委托 `@covel/api-client` |
| `packages/runtime` | 回合执行引擎 | ➕ session 启动时锁定 embedding model，执行期透明路由 |

## 数据流示例：一次 RAG 写入

1. 插件 runtime 在 `after-turn` 阶段调用 `store.upsertVector(sessionId, pluginId, 'npc-graph', edgeId, vec)`
2. `SqliteStore.upsertVector()` 查 `sessions.embedding_model_id` → 查 `vector_models.table_name` → 得到 `vec_mem_m3`
3. 写入 `vec_mem_m3` 的 `(session_id, plugin_id, namespace, key, embedding)`
4. 插件代码对物理表名一无所知，只知道逻辑四元组

## 数据流示例：一次 RAG 查询

1. 插件 runtime 调用 `store.searchVectors(sessionId, { namespace: 'npc-graph', query: vec, k: 8 })`
2. 同样路由到 `vec_mem_m3`
3. 执行 KNN（sqlite-vec 的 `vec_distance_l2` 或 pgvector 的 `<->` 操作符）
4. 结果按距离排序返回，自动过滤出 `session_id = ?` 的行（session 隔离）

## 会话生命周期中的向量锁定

```
createSession()
  ├─ 解析当前 llm.toml 的 embedding slot
  ├─ 若无配置 → embedding_model_id = NULL, RAG 禁用
  ├─ 若有配置 → UPSERT vector_models → 拿 id
  ├─ sessions.embedding_model_id = id
  └─ sessions.embedding_locked_at = now

runTurn() / resumeSession()
  ├─ 读 sessions.embedding_model_id（权威）
  ├─ 对比当前 llm.toml 配置
  ├─ 不一致 → 静默以 session 锁定值为准 + trace info event
  └─ runtime 透明路由到对应物理表

endSession()
  └─ 不动 embedding_model_id，物理表保留
```

## 跨 session 隔离 + 物理表复用

- 两个 session 使用同一个 embedding model → 共享同一张物理表，但 `session_id` 列天然隔离数据
- 两个 session 使用不同 embedding model → 走不同物理表
- 用户切换 model 后再切回旧 model → 旧物理表直接复用，历史数据继承

## 启动期自检

`bootstrapApi()` 在 backend 初始化之后执行一次自检：

```
[boot] store backend: sqlite
[boot] sqlite-vec: loaded (v0.1.7-alpha.2)
[boot] vector_models registry: 3 models, 5 physical tables
[boot] RAG plugins enabled: core-npc-graph
```

或者（PG 档位）：

```
[boot] store backend: pg
[boot] pgvector: enabled (v0.8.0)
[boot] vector_models registry: 1 model, 1 physical table
[boot] RAG plugins enabled: core-npc-graph
```

任一前置不满足（SQLite 档位 `sqlite-vec` 加载失败 / PG 档位扩展缺失）→ 启动终止，输出明确错误。

## 观测性

`/api/health` 扩展返回：

```json
{
  "storeBackend": "sqlite",
  "vector": {
    "capable": true,
    "driver": "sqlite-vec",
    "version": "0.1.7-alpha.2",
    "modelCount": 3,
    "tableCount": 5
  },
  "ragPluginsEnabled": ["core-npc-graph"]
}
```

`/api/sessions/:id` 扩展返回：

```json
{
  "id": "cloudmere-abc12345",
  "embedding": {
    "modelId": "openai/text-embedding-3-small",
    "provider": "openai",
    "modelName": "text-embedding-3-small",
    "dim": 1536,
    "lockedAt": "2026-04-15T13:42:00Z"
  }
}
```
