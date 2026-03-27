# 04. 数据库、存储层与同步架构

## 1. 推荐总原则：Postgres-first, event-aware, local-cache-ready

对 `covel`，目前最合适的不是把基础设施拆得很花，而是把一套数据库打磨到足够强。

推荐核心组合：

- PostgreSQL
- `pgvector`
- full text search
- `jsonb`
- partitioned event tables
- optional local cache (`IndexedDB` / `PGlite`)

## 2. 为什么先不用独立图数据库和独立向量库

因为 `covel` 当前最缺的是：

- 一致的数据模型
- 清晰的读写边界
- 可回放和可调试
- 与前端工作台统一的投影

这些在单一 Postgres 里更容易完成。

## 3. 推荐数据库分区

### 3.1 Core Domain Tables

- `worlds`
- `world_entries`
- `characters`
- `personas`
- `sessions`
- `messages`
- `blocks`
- `artifacts`

### 3.2 State Tables

- `world_states`
- `session_states`
- `character_states`
- `relationship_states`
- `quest_states`
- `event_states`

### 3.3 Knowledge Tables

- `memory_documents`
- `memory_chunks`
- `memory_items`
- `entities`
- `entity_edges`
- `retrieval_runs`

### 3.4 Workflow Tables

- `workflow_runs`
- `workflow_snapshots`
- `workflow_steps`
- `approval_requests`

### 3.5 Observability Tables

- `trace_records`
- `usage_records`
- `eval_runs`
- `app_logs`
- `audit_logs`

### 3.6 Event Tables

- `domain_events`
- `session_events`
- `artifact_events`

## 4. 推荐写入模型

### 4.1 命令写入

用户动作、package 动作、workflow 动作都先变成 command：

- `SendMessage`
- `SubmitBlockResponse`
- `CreateArchive`
- `ApplyStatePatch`
- `ResumeWorkflow`

### 4.2 运行时处理 command

```text
command
  -> validation
  -> flow/workflow execution
  -> proposed outputs
  -> transactional persist
  -> emit events
  -> SSE / stream to host
```

### 4.3 事务边界

推荐把这些放在同一事务里：

- 新 message/block/artifact 元数据
- state patch apply
- event append
- trace summary header

不要把“半个回合的状态”提前暴露给读模型。

## 5. `pgvector` 的具体建议

### 5.1 推荐起步方案

- 初期先用 exact search + 小规模索引
- 规模上来后切 `HNSW`
- 需要过滤时启用迭代扫描和分区/partial index

### 5.2 典型索引

```sql
CREATE INDEX memory_chunks_embedding_hnsw
ON memory_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX memory_chunks_fts_idx
ON memory_chunks USING gin (fts);
```

### 5.3 为什么对 `covel` 合适

- 向量和业务数据同库，容易做 provenance 和 join
- 可直接按 `world_id` / `session_id` / `source_type` 过滤
- 方便结合全文搜索和结构化条件

## 6. 世界与会话存储建议

### 6.1 世界内容版本化

世界文档、角色卡、世界书应有版本：

- `version`
- `published_at`
- `supersedes_version_id`

### 6.2 Session 不是唯一真相

不要把所有业务数据都绑定在 `session_id`。

更合理：

- 世界级知识属于 world scope
- 角色级状态属于 actor scope
- 会话推进属于 session scope
- 临时执行属于 run/workflow scope

### 6.3 Archive 作为压缩和分叉点

Archive 不只是备份，而是：

- 长会话压缩点
- fork 起点
- replay 校验点
- retrieval 辅助源

## 7. 同步与本地缓存建议

### 7.1 `covel` Web Host 的现实路线

短期：

- 服务端真相
- HTTP + SSE
- IndexedDB 做缓存

中期：

- query cache + optimistic local store
- shared persistent optimistic state

长期：

- 选择性引入 `PGlite` / local-first data views
- 对少数编辑面做 through-the-database sync

### 7.2 为什么不建议一开始全量 local-first

`electric` 很先进，但全量迁入本地数据库会显著增加：

- schema 管理复杂度
- migration 成本
- debug 成本
- 浏览器端资源开销

所以更适合：

- 先把 timeline / panels 维持 server-backed
- 对草稿编辑、世界编辑器、多人协作面逐步引入 local-first

## 8. 推荐 repository 接口

```ts
interface SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  updateBindings(input: UpdateBindingsInput): Promise<Session>;
  appendMessage(input: AppendMessageInput): Promise<Message>;
  listTimeline(sessionId: string): Promise<TimelineEntry[]>;
}

interface MemoryRepository {
  upsertDocument(input: UpsertMemoryDocumentInput): Promise<void>;
  search(input: SearchMemoryInput): Promise<SearchMemoryResult>;
  appendRetrievalRun(input: RetrievalRunInput): Promise<void>;
}
```

## 9. 简单 demo：检索 SQL 组合

```sql
WITH semantic_hits AS (
  SELECT id, document_id, 1 - (embedding <=> $1) AS score
  FROM memory_chunks
  WHERE scope_id = $2
  ORDER BY embedding <=> $1
  LIMIT 20
),
fts_hits AS (
  SELECT id, document_id, ts_rank_cd(fts, plainto_tsquery($3)) AS score
  FROM memory_chunks
  WHERE fts @@ plainto_tsquery($3)
  LIMIT 20
)
SELECT * FROM semantic_hits
UNION ALL
SELECT * FROM fts_hits;
```

## 10. 对 `covel` 的落地建议

### 第一阶段

- 补全 Postgres schema
- 接通 `memory-rag`
- 加 `entity_edges`
- 加 event log

### 第二阶段

- 加 workflow snapshots
- 加 read models
- 加 archive reindex

### 第三阶段

- IndexedDB cache
- optimistic state layer
- 选择性 local-first 编辑面

## 11. 仓库参考

- `pgvector/pgvector`
- `electric-sql/electric`
- `liveblocks/liveblocks`
