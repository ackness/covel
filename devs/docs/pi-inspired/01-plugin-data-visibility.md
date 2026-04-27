# 01 · plugin-data 上下文可见性双轴

> **状态**：proposed · 2026-04-26 起草 · 评审待入
> **借鉴源**：pi-mono 的 [`CustomEntry` vs `CustomMessageEntry`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md#customentry) 拆分
> **影响范围**：`@covel/store` schema · `@covel/shared` types · `@covel/context` prompt-internals · 8 个 core plugin 的 PLUGIN.md 不变（向后兼容）
> **外部依赖**：无

---

## § 0.0 当前评审结论

（待入。本节预留，外部评审落地后将原文引用 + 在正文加 `评审 #N 修正` marker。）

---

## § 0 为什么写这份文档

Covel 的 `plugin_data` 表今天承担了**两种语义完全不同的角色**，但 schema 上没有区分：

1. **要进 LLM context 的状态**：例如 `core-codex` 的术语条目、`core-npc-graph` 的关系图、`core-memory` 的 archival 块。这些通过 `input.inject: { kind: 'plugin-data', namespace, ... }` 在 PromptAssembler 装配时整段 inline 到 system prompt。
2. **不进 LLM context 的纯持久化状态**：例如 plugin 内部计数器、状态机当前态、上一次 trigger 的时间戳、人格化插件的"已说过的话清单"。今天要么硬塞进 namespace 然后被 inject 顺带 inline（污染 prompt），要么每次需要时调 `plugin-data-get` 工具（多一次 LLM 工具调用回合）。

两种角色挤在同一张表里，结果是：

- **prompt 污染**：plugin 内部状态被 inject 顺带 inline，浪费 token 也干扰 LLM
- **工具回合浪费**：避免污染只能用工具读，但工具回合本身就是 token + 延迟成本
- **schema 漂移压力**：plugin 作者为了避免污染，把内部状态偷偷写到 `plugin_configs` 表（错位），或者塞到 namespace 名带 `_internal` 前缀（约定，无强制）

pi-mono 在它的 session JSONL 里把这件事拆得很清楚：`CustomEntry` = 扩展私有状态（不进 LLM context）、`CustomMessageEntry` = 扩展注入消息（进 LLM context），同名 `customType` 关联。借鉴这个**双轴拆分**思路，落到 Covel 上就是给 `plugin_data` 加一个 `visibility` 维度。

### 不做会怎样

| 时间 | 后果 |
|---|---|
| 现在不做 | 每个新 plugin 都要在"污染 prompt"和"花工具回合"之间二选一；plugin 作者用 `_internal` 命名约定试图绕开，但 inject 配错就翻车 |
| 半年后做 | 已有 5–10 个第三方 plugin 按今天的语义写，迁移要逐个 review；约定漂移会形成 schema lock-in |
| 现在做 | schema 加一列 + 默认值兼容；inject 行为加一条规则；8 个现有 core plugin 零改动 |

---

## § 0.1 已确立的指导原则

引用项目历史决策，作为本提案的硬约束：

| 原则 | 来源 | 对本提案的约束 |
|---|---|---|
| Framework ↔ Plugin 隔离规则 | `CLAUDE.md` § Critical Conventions | 框架代码不得硬编码任何具体 plugin id、namespace 或数据结构；本提案的 visibility 字段必须由插件写入时显式声明，框架只按通用 visibility 过滤 |
| Plugin 写入只走治理入口 | `CLAUDE.md` § Plugin authoring contract | visibility 字段通过 proposal / plugin-data tool / scoped pluginData writer 等既有治理入口写入，不引入绕过 commit/trace/trust 的旁路 |
| 渐进迁移 + 默认值兼容 | `devs/docs/refactor-plan/` 系列普遍纪律 | 旧数据的 visibility 视为 `context-full`（兼容现行 inject 行为）；不强制 plugin 立刻升级 |
| `pluginId` 是数据隔离边界 | `packages/context/src/prompt-internals.ts` 的 `resolvePluginDataInject` 注释 | visibility 不能跨 plugin 读取；只能影响“自己的 namespace 进 prompt 时怎么呈现” |
| 框架不理解插件业务语义 | `devs/docs/pi-inspired/README.md` § 框架 ↔ 插件分离边界 | 框架不能按 `core-codex`/`core-guide` 等特例决定 visibility；只能执行插件声明和 store schema 规则 |

---

## § 1 现状盘点

实测扫描，每条带证据。

### 1.1 plugin_data 表 schema

[packages/store/src/sqlite/sqlite-store-mappers.ts:223-234](packages/store/src/sqlite/sqlite-store-mappers.ts:223)

```sql
CREATE TABLE IF NOT EXISTS plugin_data (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, plugin_id, namespace, key)
);
```

**没有 visibility / scope / kind 列**。Postgres 版（`packages/store/src/postgres/pg-store-mappers.ts`）也是同形 schema。

### 1.2 写入路径

| 入口 | 实现 | 状态 |
|---|---|---|
| Builtin tool `plugin-data-set` | `packages/tools/src/builtin/plugin-data-*.ts` | 已实装。LLM 调用，单条写入 |
| Builtin tool `plugin-data-set-batch` | 同上 | 已实装。LLM 调用，批量写入 |
| Proposal envelope `record.upsert` | `packages/runtime/src/turn-executor.ts` 的 commit 路径 | 已实装。Plugin handler 通过 proposal 写入 |
| 直接 store 调用 | `store.upsertPluginData(...)` | 仅框架内部用（如 plugin-config 初始化） |

**所有写路径都没有 visibility 参数**——因为字段不存在。

### 1.3 读 + inject 路径

[packages/context/src/prompt-internals.ts:184-260](packages/context/src/prompt-internals.ts:184)：

```ts
async function resolvePluginDataInject(
  inject: PluginDataInjectDecl,
  params: ContextBuildParams,
): Promise<string> {
  // ...
  const entries = await params.store.listPluginData(
    params.turnInput.sessionId,
    params.manifest.pluginId,
    inject.namespace,
  );
  // 整个 namespace 全量返回，按 maxEntries 二分截断后 inline 到 prompt
}
```

`listPluginData` 取整个 (session, pluginId, namespace) 三元组，**无 visibility 过滤**。`PluginDataInjectDecl` 的字段（[packages/shared/src/types/plugin.ts:90-100](packages/shared/src/types/plugin.ts:90)）也没有 visibility 相关选项：

```ts
export interface PluginDataInjectDecl {
  readonly kind: 'plugin-data';
  readonly namespace: string;
  readonly as: string;
  readonly format?: 'summary' | 'full' | 'ids-only';
  readonly maxEntries?: number;
}
```

### 1.4 现有 core plugin 的 plugin-data 用法盘点

`grep -rn "plugin-data-set\|plugin-data-set-batch\|listPluginData" plugins/` 结果（实测）：

| Plugin | 主要 namespace | 性质 | 今天怎么处理 |
|---|---|---|---|
| `core-codex` | `entries` | LLM 可见（术语条目） | inject `kind: plugin-data, namespace: entries` |
| `core-npc-graph` | `relationships` | LLM 可见（NPC 关系） | 通过 RAG 摘要后 inject 给 narrator |
| `core-memory` | `archival` | LLM 可见（archival memory） | inject `kind: plugin-data, namespace: archival` |
| `core-world-init` | `lore-cache` | 半可见（生成中间产物） | 不 inject；通过 record.upsert 写入 world records 后才进 prompt |
| `core-pregame` | `phase-state` | **应当私有**（pre-game 阶段进度） | 现状用 namespace 名 `phase-state` 当约定，inject 谨慎避开 |
| `core-guide` | `last-options` | 半私有（上一轮选项缓存） | 仅 plugin 内部 read，不 inject |

**关键发现**：`core-pregame` 和 `core-guide` 已经在用"约定式私有 namespace"——靠 inject 配置的人小心避开。约定但无强制 = schema 漂移已经在发生。

### 1.5 token 成本估算

实测每个 PLUGIN.md 大小（lines）：

```
core-narrator     78 lines
core-codex       163 lines
core-pregame      40 lines
core-memory       17 lines
core-guide        68 lines
core-world-init   ~ (大文件，估 300+)
core-char-creator (中等)
core-npc-graph    (中等)
```

折算 token：1 行 ~ 8–12 token，单 plugin 的 PLUGIN.md 单次进 prompt 范围在 100–4000 token。

而 `plugin_data` inject 的成本是**变长 + 累计的**。一个用了一段时间的 codex 可能存上百条 entries，summary 模式按 `maxEntries=50 × 200 char ≈ 4000 token`。**plugin-data inject 的 token 占比在长 session 里远超 PLUGIN.md 本身。**

如果其中混进了 30% 的 plugin 内部状态（"已发出过的提示编号"、"内部 LRU"），那就是白白多花 ~1200 token / turn。8 plugin × 假设 30% 比例 × 200 turn 长 session ≈ 60万 token 浪费量级。

---

## § 2 设计目标

| 目标 | 衡量 |
|---|---|
| 给 plugin_data 加一个 visibility 维度，区分"LLM 可见 vs plugin 私有" | schema 加 `visibility` 列；inject 路径默认只取 `context-*` 行 |
| 默认值兼容现行行为 | 旧数据 visibility 视为 `context-full`；现有 inject 配置零改动；8 个 core plugin 不需要立即迁移 |
| 默认安全 | 目标态新写入默认 `private`，plugin 必须显式声明才进 prompt；迁移期先走 legacy-compatible 策略，避免现有插件新写入突然消失 |
| 引入 summary 中间档 | `context-summary`：写入时同时存一个短摘要，inject 优先用 summary，节流 |
| 跨 store 一致 | SQLite / Postgres / IDB / Memory 四个 backend 同时支持；contract test 兜底 |
| 对 plugin 作者透明 | 现有 `plugin-data-set` 工具加可选 `visibility` 参数；迁移期省略时 warn，P0-d 后切到默认 `private` |

### 默认值取舍

写入默认值的两种选择：

| 默认 | 优点 | 缺点 |
|---|---|---|
| `context-full`（向后兼容旧数据） | 旧 plugin 不改任何代码，现有 inject 完全等价 | 新 plugin 作者不显式写 visibility 时，所有内部状态也进 prompt——继承今天的脚枪 |
| `private`（新写入默认安全） | 新 plugin 默认不泄漏；要进 prompt 必须声明 | 旧 plugin 在升级 store 后写入的新行如果不显式写 visibility，会从 prompt 消失——破坏现有行为 |

**采用带过渡开关的混合策略**（详见 § 5.1）：

- **数据库迁移**把已有行 visibility 写为 `context-full`（保持现状）
- **迁移期新写入**走 `legacy-compatible`：未传 visibility 时按 `context-full` 写入，但 trace/runtime warn
- **目标态新写入**走 `secure`：未传 visibility 时按 `private` 写入
- **现有 core plugin** 在 § 6 的 P0-c 阶段被显式审查并加上正确的 visibility 声明；P0-d 之后再把默认策略切到 secure

建议临时 feature flag：

```bash
COVEL_PLUGIN_DATA_DEFAULT_VISIBILITY=legacy|private
```

默认值：P0-a/P0-b/P0-c 为 `legacy`，P0-d 切为 `private`。

---

## § 3 边界（Non-goals）

明确**不做**的事，避免范围蔓延：

- 不引入跨 plugin 的 plugin-data 读取（仍然遵守 `pluginId` 隔离）
- 不改 `plugin_configs` 表（那是配置，不是状态）
- 不改 `record.upsert` proposal envelope 形状（visibility 仅作用于 plugin_data，不延伸到 records / characters）
- 不引入 visibility 的 RBAC / 加密 / 多租户等概念（这些在 trust-tier 和 deployment-tier 里另外解）
- 不做 pi 的 progressive PLUGIN.md body（在本目录的 § 全景图里另立 spec，本提案聚焦 plugin_data）
- 不做 SSE 推送 visibility 变更（现有 `plugin-data.changed` 事件保持原样）

---

## § 4 总体架构

### 4.1 三档可见性

```
                          plugin_data row
                                │
                ┌───────────────┼────────────────┐
                ▼               ▼                ▼
            private        context-summary   context-full
        (永不进 prompt)   (仅 summary 进)    (整 row 进)
                │               │                │
                │               │                │
        ┌───────┴───────┐       │       ┌────────┴────────┐
        │ plugin-data   │       │       │ inject 全量序列  │
        │   -get 工具   │       │       │ 化（旧行为）    │
        │ （明示读取） │       │       │                 │
        └───────────────┘       │       └─────────────────┘
                                ▼
                      ┌─────────────────────┐
                      │ inject 取 summary    │
                      │ 字段，缺失时降级     │
                      │ 到 ids-only         │
                      └─────────────────────┘
```

### 4.2 写路径

```
plugin handler / LLM tool
        │
        ▼
plugin-data-set { key, value, visibility?, summary? }
        │
        ▼
store.upsertPluginData(...)  ← 新签名带 visibility + summary
        │
        ▼
plugin_data row { ..., visibility, summary }
```

### 4.3 inject 装配路径

```
PromptAssembler.buildInjectBlocksAsync
        │
        ▼
resolvePluginDataInject(inject, params)
        │
        ▼
store.listPluginData(sessionId, pluginId, { namespace, visibility: ['context-summary','context-full'] })
        │
        ▼
按 row.visibility 决定每行渲染：
  - context-full → format=full|summary|ids-only 走旧分支
  - context-summary → 优先取 row.summary 字段；
                       缺失则 fallback 到 ids-only，绝不 fallback 到 full
  - private → 不可达（已在 store 层过滤；公开 PLUGIN.md inject 不提供 includePrivate）
```

---

## § 5 详细设计（按主题）

> § 5 按主题组织，真实落地顺序以 § 6 的 P0-a/b/c/d 为准。

### 5.1 plugin_data 加 visibility + summary 列

**当前问题**

[`plugin_data`](packages/store/src/sqlite/sqlite-store-mappers.ts:223) 表只有 `(session, pluginId, namespace, key, value)` 五元组语义：

- 1 张表承担两种语义角色（LLM 可见 / plugin 私有），无强制区分
- inject 时整 namespace 全量取出；plugin 作者要"私有"只能靠 namespace 命名约定
- 实测 `core-pregame` / `core-guide` 已在用约定式私有 namespace（§ 1.4），约定漂移已经在发生

**提议方案**

加两列：

```sql
ALTER TABLE plugin_data
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'context-full',
  ADD COLUMN summary TEXT;
```

类型层面：

```ts
// packages/shared/src/types/plugin.ts
export type PluginDataVisibility =
  | 'private'           // 永不进 prompt；只能通过 plugin-data-get 工具读
  | 'context-summary'   // inject 时取 summary 字段（短摘要）
  | 'context-full';     // inject 时取整 value（旧行为）

export interface PluginDataRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly visibility: PluginDataVisibility;
  readonly summary?: string;     // visibility = 'context-summary' 时必填
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

迁移规则：

- 已有行：`visibility = 'context-full'`（保留行为）
- 迁移期新写入：默认 `context-full` + warn（legacy-compatible）
- 目标态新写入：默认 `private`（安全默认；显式声明才进 prompt）
- 写入时若 `visibility = 'context-summary'` 但 `summary` 为空 → store 层抛错（schema 校验）

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `packages/store/src/sqlite/sqlite-store-mappers.ts` | DDL 加列；`toPluginDataRecord` 加映射 |
| `packages/store/src/postgres/pg-store-mappers.ts` | 同 SQLite，PG 类型用 `text` |
| `packages/store/src/idb/...` | IDB schema bump，加索引 `(session, pluginId, namespace, visibility)` |
| `packages/store/src/memory/...` | 内存版结构体加字段 |
| `packages/store/tests/store-contract.ts` | contract test 加 visibility 写读 + inject filter case |
| `packages/store/migrations/<next>-plugin-data-visibility.sql` | 加迁移脚本（PG 走 drizzle migrate；SQLite 走 IF NOT EXISTS DDL） |

**旧代码可清理**

```diff
-export interface PluginDataRecord {
-  readonly id: string;
-  readonly sessionId: string;
-  readonly pluginId: string;
-  readonly namespace: string;
-  readonly key: string;
-  readonly value: unknown;
-  readonly createdAt: string;
-  readonly updatedAt: string;
-}
+export interface PluginDataRecord {
+  readonly id: string;
+  readonly sessionId: string;
+  readonly pluginId: string;
+  readonly namespace: string;
+  readonly key: string;
+  readonly value: unknown;
+  readonly visibility: PluginDataVisibility;
+  readonly summary?: string;
+  readonly createdAt: string;
+  readonly updatedAt: string;
+}
```

约定式私有 namespace（如 `_internal-*` 命名）可以在 P1 阶段统一删除，但本提案不强制清理。

**清理后的后果**

- 无法回滚：迁移完成后旧 record 已带 `visibility='context-full'`，回滚需要丢列；建议在 P0 阶段保留 7 天观察窗口
- 缓解：迁移脚本是加列，不删列；如需回退只需停用代码读 visibility 即可，schema 兼容

**这条改动 unlocks 什么**

1. plugin 内部状态可以放回 `plugin_data`（不再外溢到 `plugin_configs` 误用）
2. inject 配置语义清晰："inject 默认只看 context-* 行"
3. 第三方 plugin 默认安全：忘记声明 visibility = 不会泄漏
4. 为后续 context budget breakdown、branch summary、session export/replay 提供统一可见性词汇

### 5.2 store API 加 visibility 过滤参数

**当前问题**

[`listPluginData`](packages/store/src/types.ts) 现签名：

```ts
listPluginData(sessionId: string, pluginId: string, namespace?: string): Promise<PluginDataRecord[]>
```

无 visibility 维度。inject 装配时全量返回，由 `resolvePluginDataInject` 按 namespace 整体处理。

**提议方案**

加一个可选 filter：

```ts
export interface ListPluginDataOptions {
  readonly namespace?: string;
  readonly visibility?: ReadonlyArray<PluginDataVisibility>;
  readonly keyPrefix?: string;
}

listPluginData(
  sessionId: string,
  pluginId: string,
  options?: ListPluginDataOptions,
): Promise<readonly PluginDataRecord[]>;
```

旧的 `listPluginData(sid, pid, ns)` 调用签名通过 overload 保留兼容（`ns` 字符串 → `{ namespace: ns }`）。

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `packages/store/src/types.ts` | 加 `ListPluginDataOptions` + overload |
| `packages/store/src/{sqlite,postgres,idb,memory}/...` | 实现支持 visibility filter |
| `packages/store/tests/store-contract.ts` | 加 visibility filter 用例 |
| `packages/context/src/prompt-internals.ts:resolvePluginDataInject` | 调用时传 `{ visibility: ['context-summary','context-full'] }` |
| 框架内其它调用点（`grep -rn "listPluginData" packages/`） | 全部审查；plugin-data-list 工具可能要走新 visibility 选项 |

**旧代码可清理**

```diff
-const entries = await params.store.listPluginData(
-  params.turnInput.sessionId,
-  params.manifest.pluginId,
-  inject.namespace,
-);
+const entries = await params.store.listPluginData(
+  params.turnInput.sessionId,
+  params.manifest.pluginId,
+  {
+    namespace: inject.namespace,
+    visibility: ['context-summary', 'context-full'],
+  },
+);
```

公开 `PLUGIN.md` 的 plugin-data inject 不支持 `includePrivate`。`private` 的语义是“永不进入 prompt”；debug/admin API 如需查看 private 行，应走单独内部参数，而不是复用 prompt inject。

**清理后的后果**

- 无法回滚：契约测试覆盖；store backend 不实现 filter 会被 contract test fail，倒逼实现一致
- 缓解：旧 overload 保留，调用方零改动

**这条改动 unlocks 什么**

1. inject 路径默认看不到 private 行——脚枪关上了
2. plugin 内部 read 仍可通过 tool/RPC 明确读取自己的 private 数据，但不会被 prompt inject 隐式带入
3. UI 调试面板可以分别展示"LLM 可见"和"plugin 私有"两类数据
4. 未来要做 visibility 级别 trace（"哪一行被 inline 进了 prompt"）有 hook 点

### 5.3 PluginDataInjectDecl 加 summary 模式（不公开 includePrivate）

**当前问题**

[`PluginDataInjectDecl`](packages/shared/src/types/plugin.ts:90)：

```ts
export interface PluginDataInjectDecl {
  readonly kind: 'plugin-data';
  readonly namespace: string;
  readonly as: string;
  readonly format?: 'summary' | 'full' | 'ids-only';
  readonly maxEntries?: number;
}
```

`format=summary` 现在是 store 层的"截断到 200 字符"机制，不是行级别的人工摘要。一个 codex entry value = 800 字符的描述，summary 还是会塞 200 字符。

**提议方案**

加可选字段：

```ts
export interface PluginDataInjectDecl {
  readonly kind: 'plugin-data';
  readonly namespace: string;
  readonly as: string;
  readonly format?: 'summary' | 'full' | 'ids-only';
  readonly maxEntries?: number;

  /**
   * Default `'auto'`. Controls how `context-summary` rows are rendered.
   * - `auto`   → use `row.summary` if present, fall back to `format`
   * - `prefer-summary` → always use `row.summary`; fall back to ids-only if missing
   * - `ignore-summary` → behave as if `summary` field doesn't exist (full row, like today)
   */
  readonly summaryMode?: 'auto' | 'prefer-summary' | 'ignore-summary';
}
```

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/plugin.ts` | 类型加字段 |
| `packages/shared/src/schemas/plugin.ts` | Zod schema 加字段 |
| `packages/context/src/prompt-internals.ts` | `resolvePluginDataInject` 实现新逻辑 |
| `packages/context/tests/prompt-internals.test.ts` | 新增 3 类用例（auto / prefer-summary / ignore-summary）+ private 行不会进入 prompt 的过滤用例 |
| `docs/reference/plugins.md` | 更新 inject 文档 |
| `docs/guide/plugin-authoring.md` | 加"如何选 visibility"小节 |

**旧代码可清理**

无旧代码删除——这是纯加性变更。

**清理后的后果**

- 现有 inject 配置零改动 = `summaryMode='auto'`，行为等价；private 行即使同 namespace 也不会进入 prompt
- 文档需要同步（CLAUDE.md 强制要求文档 sync）

**这条改动 unlocks 什么**

1. plugin 作者能写"长 entry，短 summary"模式——比如 codex 条目 value 是完整描述、summary 是一句话；inject 默认走 summary，节流 50%+ token
2. 调试面板可加 toggle："显示完整 inject 原文 / 显示 LLM 实际看到的"
3. 跨 entry 摘要（plugin 自己生成 summary）成为一等公民，不需要再起一个新 namespace

### 5.4 plugin-data-set 工具加 visibility + summary 参数

**当前问题**

[`plugin-data-set`](packages/tools/src/builtin/plugin-data-set.ts) 工具现签名：

```ts
{
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  ttl?: number;
}
```

没法在 LLM 调用工具时声明 visibility。

**提议方案**

加两个可选参数：

```ts
{
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  visibility?: 'private' | 'context-summary' | 'context-full';  // 迁移期默认 legacy；P0-d 后默认 private
  summary?: string;                                              // visibility='context-summary' 时必填
  ttl?: number;
}
```

校验规则（store 层 + tool 层各一遍）：

- `visibility='context-summary'` 但 `summary` 缺失 → tool 报错（fail-fast，不让进 LLM 重试循环）
- `summary` 长度 > 200 字符 → 截断 + warn

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `packages/tools/src/builtin/plugin-data-set.ts` | tool schema + 实现 |
| `packages/tools/src/builtin/plugin-data-set-batch.ts` | 同上 |
| `packages/tools/src/builtin/plugin-data-get.ts` | 返回值带 visibility（让 plugin handler 读取后能判断） |
| `packages/tools/tests/...` | 新用例 |
| `docs/reference/tools.md` | 更新工具签名文档 |

**旧代码可清理**

无删除；纯加性。

**清理后的后果**

- 工具签名是向后兼容的（新参数都可选）
- 迁移期 LLM 调用旧 prompt 写入新行 → 按 legacy-compatible 默认 `context-full`，同时 trace warn
- P0-d 后默认切到 `private`，该行不会自动进 prompt——需要 plugin 作者显式声明
- 缓解：P0-a 起每次 plugin-data-set 调用如果未声明 visibility，runtime 在 trace 里打 warn

**这条改动 unlocks 什么**

1. LLM 自己写的内部状态默认不污染未来 turn 的 prompt
2. plugin handler / LLM 都能用同一套语义控制"这行该不该进 prompt"
3. 调试时可以通过 trace 里的 visibility 字段过滤"plugin 写了什么但 LLM 没看见"

### 5.5 record.upsert proposal 不变 + plugin-data 写入路径补 visibility

**当前问题**

[`record.upsert`](packages/runtime/src/turn-executor.ts) proposal 用于 records 表（`records` 不是 `plugin_data`）。但 plugin handler 的 RPC 里有 `pluginDataSet` 写入路径——它绕过 LLM tool 但仍要支持 visibility。

**提议方案**

不改 `record.upsert` envelope（边界划清，§ 3 已声明）。**只**给 `pluginDataSet` RPC 加可选 visibility 字段：

```ts
// packages/shared/src/types/rpc.ts
interface PluginDataSetRequest {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  visibility?: PluginDataVisibility;
  summary?: string;
}
```

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/rpc.ts` | 加字段 |
| `packages/runtime/src/rpc-defaults/plugin-data.ts` | 默认 dispatcher 透传 |
| `packages/runtime/tests/...` | 加用例 |

**旧代码可清理**

无删除。

**清理后的后果**

- plugin handler RPC 调用如果不传 visibility，遵循同一默认策略：迁移期 legacy-compatible，P0-d 后 `private`
- 这与 5.4 的 LLM tool 默认值一致；行为统一

**这条改动 unlocks 什么**

1. plugin handler 端和 LLM tool 端用同一份 visibility 词汇表
2. RPC trace 也带 visibility，调试链路完整

### 5.6 调试面板展示双轴

**当前问题**

`/debug` 页面的 Data Explorer 把所有 plugin_data 行平铺，没有"LLM 可见 / plugin 私有"的分组。开发期 + 玩家事故排查都不直观。

**提议方案**

Data Explorer 顶部加 segmented control：`全部 | LLM 可见 | plugin 私有`。点 "LLM 可见" 时同时显示某行实际进 prompt 的形态（取决于该 namespace inject 的 summaryMode）。

**框架其他部分需要适配**

| 文件 | 改动 |
|---|---|
| `apps/web/src/routes/debug/data-explorer.tsx` | 加 filter UI |
| `apps/web/src/routes/debug/...` | 加"实际 inject 形态"预览组件（call 同一份 `resolvePluginDataInject` 渲染） |

**旧代码可清理**

无。

**清理后的后果**

- UI 加了三个状态 → 测试增加，但是新功能不破坏旧
- 缓解：放在 P1 阶段，与 P0 的 schema/api 解耦

**这条改动 unlocks 什么**

1. 开发期能直接看到"我标了 private 的行没有进 prompt"
2. 玩家提交诡异 bug 时，运维能快速判断是 LLM 看到了奇怪数据还是没看到本该看到的
3. 为未来 visibility 级别 audit log 留了 UI 入口

---

## § 6 迁移计划（按时间）

> § 5 按主题组织，真实落地顺序以本 § 的 P0-a/b/c/d + P1 为准。

### P0-a · 2026-04 末（地基：schema + types）

- 类型 & schema：§ 5.1 PluginDataRecord + § 5.3 InjectDecl + § 5.4 工具签名
- 迁移脚本：DDL 加列（PG / SQLite / IDB schema bump / Memory 结构体）
- 旧数据：`visibility='context-full'`（保现状）
- 单元测试：新字段读写 + visibility filter
- 依赖：无；可独立合入

### P0-b · 2026-05 第 1 周（store API + inject 装配）

- store API：§ 5.2 `ListPluginDataOptions` + 四个 backend 实现
- inject 装配：§ 5.3 `resolvePluginDataInject` 新实现
- contract test：跨 backend 一致性
- 依赖：P0-a 已落地

### P0-c · 2026-05 第 2–3 周（插件侧显式声明 visibility）

逐个 plugin 审查并写入正确 visibility，不破坏行为。注意：这是**插件代码/插件工具调用**的改动，不允许在框架层写 `if pluginId === ...` 的特例映射。下表只是迁移清单，不是框架逻辑：

| Plugin | 主要 namespace | 目标 visibility |
|---|---|---|
| core-codex | entries | context-summary（同步加 summary 字段写入） |
| core-npc-graph | relationships | context-summary（已有 RAG summary，复用） |
| core-memory | archival | context-full（现行行为） |
| core-pregame | phase-state | private（修正现状的"约定" → 强制） |
| core-guide | last-options | private（同上） |
| core-world-init | lore-cache | private |
| core-char-creator | drafts | private |

每个 plugin 一个独立 PR；E2E 跑一遍 `scripts/e2e-plugin-verify.ts` 兜底。

### P0-d · 2026-05 第 4 周（运维收尾）

- LLM tool 默认 `private` 切换（§ 5.4 默认值生效；`COVEL_PLUGIN_DATA_DEFAULT_VISIBILITY=private`）
- 添加 trace warn："plugin-data-set 调用未声明 visibility → 默认 private"
- 文档：`docs/reference/plugins.md` / `docs/reference/tools.md` / `docs/guide/plugin-authoring.md` 全部 sync
- 依赖：P0-c 全部 plugin 显式声明完毕，否则 LLM tool 默认值切换会破坏现存 plugin

### P1 · 2026-06+（DX + 调试增强）

- § 5.6 调试面板双轴展示
- `/debug/data-explorer` 加 visibility filter
- contract test 性能基线（visibility filter 应当走索引，不退化全表扫描）
- 依赖：P0 全部完成

---

## § 7 风险 / Tradeoffs

| 风险 | 缓解 |
|---|---|
| P0-c 期间某 plugin 的 visibility 标错（应当 context-* 但标了 private）→ inject 突然空 | E2E harness 在每个 plugin 切 visibility 时跑一遍验证；trace warn "inject namespace 命中 0 行" 给运维信号 |
| `summary` 字段被滥用（plugin 作者写很长的 summary 等同失效） | store 层硬截断 200 字；UI 给可视化告警 |
| 旧 plugin 升级了 store 但忘了改 plugin-data-set 调用 → P0-d 后新行变 private 不进 prompt | P0-a 起 legacy-compatible + trace warn；P0-c core plugin 显式声明；P0-d 再切默认 |
| Postgres schema 迁移期间锁表 | 加列 + 默认值在 PG 14+ 是 metadata-only 操作，不锁；contract test 验证 |
| IDB schema bump 强制刷新所有桌面端 / 浏览器端缓存 | IDB 升级走 `onupgradeneeded` 标准路径；旧数据仍可读，新写入带 visibility |

---

## § 8 是否必须现在做？

| 时间窗 | 后果 | 成本 |
|---|---|---|
| 现在不做 | `core-pregame` / `core-guide` 继续靠命名约定避开污染；下一个第三方 plugin 复制约定，schema 漂移加深 | 0（短期）/ 大（半年后） |
| 半年后做 | 已有 5–10 个 plugin 按约定写，每个迁移要单独 review；可能要一个"约定 → schema"的过渡期，工作量翻倍 | 2× 现在做的成本 |
| 现在做 | schema 加 2 列；4 个 backend 实现 visibility filter；8 个 plugin 显式标记；耗时 ≈ 4 周 | 1× 基线 |

**结论**：现在做的边际成本最低，越拖越贵。

---

## § 9 待决问题

按子领域分组。每条都需要决定才能完整收尾。

### § 9.1 store 层

- **Q1**：visibility 是否应当出现在 `plugin_data` 唯一约束里？候选：
  - A. 不进 unique key，行级别属性（推荐）
  - B. 进 unique key，允许同 (sid, pid, ns, key) 写多行不同 visibility
  - 倾向 A，保持现有 unique 语义
- **Q2**：`summary` 是否要走 trigram / FTS 索引？或者纯顺序扫描？
  - 长 session 单 namespace 行数 < 1000 量级，FTS 暂不需要
  - 留给 P1

### § 9.2 类型 & API

- **Q3**：visibility 字符串字面量 vs 枚举？
  - 选字符串字面量联合（与 typescript/coding-style.md 一致：避免 enum）
- **Q4**：是否允许公开 manifest `input.inject` 读取 private 行？
  - 不允许。private 的语义是“永不进入 prompt”。debug/admin 可以通过单独 API 参数查看，但不走 prompt inject。
- **Q5**：是否要给 `record.upsert` proposal 也加 visibility？
  - 不（§ 3 已声明）。records 表不进 LLM context（除非显式 inject），与 plugin_data 角色不同

### § 9.3 迁移

- **Q6**：P0-c 的 plugin 显式声明，是 plugin 作者改 PLUGIN.md 还是改 handler？
  - 改 handler。PLUGIN.md 的 `input.inject` 表达的是"读"，写入的 visibility 由 handler / LLM tool 调用方决定
- **Q7**：迁移期 trace warn 的级别？
  - `warn`（不是 `error`），因为旧调用站点还在过渡

---

## § 10 下一步

按时间：

1. 本 spec 进 PR review（评审意见 inline 进 § 0.0）
2. 评审通过后，P0-a 开 issue（store schema + types），单 PR
3. P0-b 紧随，单 PR（API + inject）
4. P0-c 拆 8 个独立 PR，每个 plugin 一个
5. P0-d 最后切默认值 + 文档 sync

---

## 附录 A · 类型定义草案位置

| 类型 | 文件 | 行号（提案完成后预期） |
|---|---|---|
| `PluginDataVisibility` | `packages/shared/src/types/plugin.ts` | 跟在 `OutputKind` 后 |
| `PluginDataRecord`（增字段） | `packages/shared/src/types/plugin.ts` | 现有定义 |
| `ListPluginDataOptions` | `packages/store/src/types.ts` | DataStore 接口附近 |
| `PluginDataInjectDecl`（增字段） | `packages/shared/src/types/plugin.ts:90` | 现有定义 |
| `PluginDataSetRequest`（增字段） | `packages/shared/src/types/rpc.ts` | 现有 RPC 类型集 |

---

## 附录 B · 调研项目对照

| pi-mono 概念 | Covel 对应 | 异同 |
|---|---|---|
| `CustomEntry` | `plugin_data` row with `visibility='private'` | 都是"扩展私有状态" |
| `CustomMessageEntry` | `plugin_data` row with `visibility='context-*'` | 都进 LLM context；Covel 加了 summary 中间档 |
| `customType` 关联 | `pluginId` 关联 | 都按"谁写的就归谁读"隔离 |
| pi 的 JSONL append-only | Covel 的关系数据库 upsert | 不强求 append-only；pi 是 coding-agent 单文件 session，Covel 是多 session 多 player 持久化 |
| pi 的 `display: boolean` 字段 | Covel UI 可见性是另一轴（Web `/debug`）；不与 LLM visibility 混 | 拆得更清楚 |

---

## 附录 C · 现有插件 / 代码实测盘点

实测命令 + 输出（grep 时间：2026-04-26）：

```bash
$ grep -rn "namespace:" plugins/ | grep -v node_modules | head -10
plugins/core-codex/PLUGIN.md:        namespace: entries
plugins/core-npc-graph/PLUGIN.md:    namespace: relationships
plugins/core-memory/PLUGIN.md:       namespace: archival
plugins/core-pregame/handler.js:     namespace: 'phase-state'
plugins/core-guide/handler.js:       namespace: 'last-options'

$ wc -l packages/store/src/sqlite/sqlite-store-mappers.ts
752 lines

$ grep -n "plugin_data" packages/store/src/sqlite/sqlite-store-mappers.ts
223:    CREATE TABLE IF NOT EXISTS plugin_data (
234:    CREATE INDEX IF NOT EXISTS plugin_data_session_id_idx ON plugin_data(session_id);
622:export function toPluginDataRecord(row: typeof schema.pluginData.$inferSelect): PluginDataRecord {

$ grep -rn "listPluginData\|upsertPluginData" packages/ --include='*.ts' | wc -l
~30 调用站点（具体文件清单 P0-a 单独枚举）
```

---

## 附录 D · 总体意义

本提案是 [`pi-inspired/README.md`](./README.md) 全景图里的 **# 01 条**——把 pi 的 `CustomEntry` / `CustomMessageEntry` 拆分思路落到 Covel 的 plugin_data 表上。

**它是一切后续提案的语义地基**：

- # 04（分支切换自动摘要）的摘要可以用 `visibility='context-summary'` 存
- # 07（Session export/replay/share）的导出格式直接复用 visibility 字段
- # 11（Context budget breakdown）可以按 visibility/namespace 统计 prompt 成本
- # 05（plugin 过滤语法）可以在调试 UI 中结合 visibility 展示启停后哪些数据仍会进入 prompt

把这一格钉对了，剩下的提案都能在同一份语义词汇表上拼出来。
