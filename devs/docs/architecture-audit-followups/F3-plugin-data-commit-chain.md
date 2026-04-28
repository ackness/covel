# F3 · 把 `plugin-data` 写路径纳入统一 commit chain

**Status**: ✅ done · **Landed**: 2026-04-21 · **Est**: 5–7 h(实际 ~6 h) · **Risk**: medium(已覆盖) · **Depends on**: F1 + F2(已完成)

> 本文档已更新为 as-shipped 状态。
> - §1 保留为修复前状态描述(历史背景)。
> - §2 起反映实际 landed 代码;§8 列出与最初计划的具体差异。

---

## 1. 背景:为什么需要这个(修复前状态)

### 1.1 Covel 的治理主线

Covel 的核心设计原则是**"所有持久化状态写入都是 proposal,都过 commit chain"**。这条主线让框架能:

- 统一加 **审批**(RPC 审批、第三方插件 trust tier 限制)
- 统一加 **事务**(`COVEL_COMMIT_TXN_V1` 把整轮 commit 包进 PG/SQLite 事务)
- 统一加 **Hook 拦截**(`PreStateCommit` / `PostStateCommit` 是审计 F2 刚接通的)
- 统一加 **审计 / 配额 / 回滚**(未来能力)

具体体现:LLM runtime 产出 `RuntimeResult.proposals[]`,框架经 `createCommitPipeline()` 统一 commit。`ProposalType` 联合类型目前有:

```
narrative.append | state.patch | event.emit | record.upsert |
ui.render | asset.generate | lorebook.upsert
```

### 1.2 `plugin-data` 当前在"主线外"

但有一类写入**完全绕开了 commit chain** ——`plugin-data`:

**证据 A** · [`packages/tools/src/builtin/plugin-data-tools.ts:35-98`](../../../packages/tools/src/builtin/plugin-data-tools.ts)

内置工具 `plugin-data-set` / `plugin-data-set-batch` 在 `execute()` 里**直接调 `store.setPluginData(...)`**,不产出 proposal:

```ts
// 当前实现(简化)
export const pluginDataSetTool: BuiltinTool = {
  name: 'plugin-data-set',
  execute: async ({ pluginId, namespace, key, value }, { store }) => {
    await store.setPluginData({ sessionId, pluginId, namespace, key, value });
    //    ^^^^^^^^^^^^^^^^^^^^^ 绕开 commit pipeline
    return { ok: true };
  },
};
```

**证据 B** · [`plugins/codex/tools/unlock-codex-entries.js:52-80`](../../../plugins/codex/tools/unlock-codex-entries.js)

插件的 local tool 也这样写:

```js
// 每个 entry 直接 setPluginData
await context.store.setPluginData({
  sessionId: context.sessionId,
  pluginId: 'codex',
  namespace: 'entries',
  key: shortId,
  value: entry,
});
```

**证据 C** · [`apps/server/src/routes/api/bootstrap.ts:808–815`](../../../apps/server/src/routes/api/bootstrap.ts) 的代码注释明确承认这一点:

> Because these writes skip the commit pipeline, `PreStateCommit` hooks cannot currently intercept them. Plugins that require PreStateCommit governance on their persistent data MUST use the proposal pipeline.

### 1.3 这双轨制造成的实际问题

| 能力 | proposal 路径 | direct-store 路径 |
|------|--------------|-------------------|
| `PreStateCommit` hook 拦截 | ✅ | ❌ |
| `PostStateCommit` hook 观察 | ✅ | ❌ |
| `COVEL_COMMIT_TXN_V1` 事务原子性 | ✅ | ❌ |
| Trace event(`proposal.committed`) | ✅ | ❌(只有 `plugin-data.changed` 事件 emit) |
| 未来的审批/配额 | 统一加 | 要二次实现 |

具体例子:

- 社区插件作者想做"**图鉴条目写入前打版权水印**"——没钩子可挂。
- 运维想做"**每个插件每回合写入 ≤ 100 KB**"——proposal 侧能统一数字,plugin-data 侧要单独拦。
- 开启事务后,叙事写 + plugin-data 写会出现"**一半落盘,一半挂**"的状态漂移。

---

## 2. 目标(已达成)

**一句话**:`plugin-data-set` / `plugin-data-set-batch` 以及全部 core 插件 local tool 的写入已纳入 Session Kernel commit chain,受 `PreStateCommit` / `PostStateCommit` 与 `COVEL_COMMIT_TXN_V1` 事务管控;`store.setPluginData` 保留为底层 API,供 commit handler 本身及生命周期 guard 合法使用。

---

## 3. 实际实现

### 3.1 Proposal 类型 —— `plugin.data` / `plugin.data.batch`

命名与最初计划不同:落地版本采用与 `working_memory.set` / `lorebook.upsert` 一致的点分风格。

[`packages/shared/src/types/proposal.ts`](../../../packages/shared/src/types/proposal.ts)

```ts
export type ProposalType =
  | 'narrative.append'
  | 'narrative.template'
  | 'state.patch'
  | 'event.emit'
  | 'record.upsert'
  | 'interaction.request'
  | 'ui.render'
  | 'asset.generate'
  | 'plugin.data'        // ← 新增
  | 'plugin.data.batch'  // ← 新增
  | 'working_memory.set'
  | 'lorebook.upsert';

export interface PluginDataPayload {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

export interface PluginDataBatchPayload {
  readonly items: readonly PluginDataPayload[];
}
```

与最初计划的字段差异:

- **Payload 无 `pluginId`** —— 直接从 `proposal.source.pluginId` 取,消除冗余字段
- **Payload 无 `expiresAt`** —— 当前 store API 无 TTL 需求,按需再加
- **Batch 字段叫 `items`**(不是 `records`),与 `LorebookUpsertPayload.entries` 保持同类风格

### 3.2 Commit handler —— `commitPluginData` / `commitPluginDataBatch`

[`packages/runtime/src/session-kernel.ts`](../../../packages/runtime/src/session-kernel.ts) 约 430–489 行。两个 handler 注册在 `createCommitPipeline` 的 handler table 中,每条 proposal 依序经过:

1. `PreStateCommit` hook —— 可拦截 / 替换 / 放行
2. 执行 handler(调用 `store.setPluginData` / `store.setPluginDataBatch`)
3. `proposal.committed` trace event 落 `trace_events`
4. `PostStateCommit` hook —— 纯观测(不能 abort)

实现要点:

- `pluginId` 从 `proposal.source.pluginId` 抽取;每条记录的 `id` 由 handler 自己 `crypto.randomUUID()` 生成
- Batch 走**单一 proposal + 内部展开**(对应原计划 3.1.3 选项 A),事务粒度是一整个 batch;hook 只被调用一次,性能可控
- 参数校验:`namespace` / `key` 必须非空字符串;batch `items` 必须非空数组
- Store 无 `setPluginData(Batch)` 能力时(thin mock)返回 `{ committed: false, error: ... }` 而非抛异常

### 3.3 Tool 侧协议 —— `withPendingProposals` 非侵入 carrier

**与计划差异最大的一处**:最初计划把 `ToolResult` 扩展为显式的 `{ content, pendingProposals }`。实际采用**非侵入的 Symbol carrier** 协议:

[`packages/tools/src/result.ts`](../../../packages/tools/src/result.ts)

```ts
const TOOL_PENDING_PROPOSALS = Symbol.for('covel.tools.pendingProposals');
const TOOL_EXECUTION_ENVELOPE = Symbol.for('covel.tools.executionEnvelope');

export function withPendingProposals<T extends object>(
  content: T,
  pendingProposals: readonly Proposal[],
): T;  // 返回 content 本身,Symbol 属性非枚举
```

tool 作者的使用方式(所有已迁移 tool 统一):

```ts
return withPendingProposals(
  { success: true, namespace, key },       // 给 LLM 看的内容,不变
  [ makePluginDataProposal(context, { namespace, key, value }, now) ],
);
```

协议优势:

- **对 LLM 和旧 adapter 完全透明**:`JSON.stringify` 忽略 Symbol 属性,LLM 看到的仍是 `{ success: true, ... }`
- **零破坏**:旧 adapter 不读 Symbol 属性,等效 `pendingProposals = []`
- **不动 `ToolResult` / `tool.execute` 的类型签名**(仍是 `unknown`),避免推动全仓 tool 文件改签名
- Content 不可扩展(primitive)时自动回退到 envelope `{ content, pendingProposals, [TOOL_EXECUTION_ENVELOPE]: true }`;消费端 `getPendingProposals(v)` 两种形状都能解

### 3.4 Runtime 汇聚 —— ToolCallResult + turn-executor

[`packages/runtime/src/tool-executor.ts:52-60`](../../../packages/runtime/src/tool-executor.ts)

```ts
export interface ToolCallResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result: string;              // JSON for LLM
  readonly parsedResult: unknown;       // via getToolContent(rawResult)
  readonly pendingProposals?: readonly Proposal[];  // via getPendingProposals(rawResult)
  readonly success: boolean;
  readonly approvalStatus?: ApprovalStatus;
}
```

`createToolExecutor.execute` 在调用 `tool.execute` 后,`getToolContent()` 取对 LLM 可见的部分、`getPendingProposals()` 取 proposal 队列,分别填入 `ToolCallResult`。

[`packages/runtime/src/turn-executor.ts`](../../../packages/runtime/src/turn-executor.ts) 在 tool loop 中累积 `pendingProposals: Proposal[]`(主循环约 2121 行、resume 路径约 1274 行;suspension 路径会把 pendingProposals 一并持久化到 `SuspensionRecord.pendingContinuation`)。runtime 末尾通过 `withPendingProposals(output, pendingProposals)` 把整批 proposal 挂到 runtime output,最终由外层 Session Kernel commit chain 消费。

### 3.5 内置 tool 改写

[`packages/tools/src/builtin/plugin-data-tools.ts`](../../../packages/tools/src/builtin/plugin-data-tools.ts)

- `plugin-data-set` / `plugin-data-set-batch` —— 改为产出 proposal + `withPendingProposals`,**不再**直接调 `store.setPluginData`
- `plugin-data-get` / `plugin-data-list` —— 读路径无治理需求,仍直接调 store

### 3.6 Core 插件 local tool 迁移

已迁移到 `withPendingProposals(...)` + `plugin.data(.batch)` proposal:

- `plugins/codex/tools/unlock-codex-entries.js` (batch)
- `plugins/codex/tools/update-codex-entry.js` (single)
- `plugins/guide/tools/generate-guide.js` (batch)
- `plugins/world-init/tools/set-world-schema.js` (single)
- `plugins/world-init/tools/set-world-entries-batch.js` (batch;`lorebook_entries` 双写保留)
- `plugins/npc-graph/tools/upsert-npc-graph.js` (batch)

验证:`grep -rn "store\.setPluginData" plugins/*/tools/` → 0 命中。

### 3.7 保留的直接调用(设计性例外)

- **`plugins/world-init/guard.js`** 仍直接调 `s.setPluginData(Batch)`。Guard 是 `onPreGame` 生命周期钩子,在 runtime 回合之外运行、没有 `turnId`、不产出 `RuntimeResult`,无法走 proposal 管道。保留直接写是**有意选择** —— guard 是框架级同步初始化逻辑,不在 LLM 可达写路径上。
- **`store.setPluginData` 作为底层 API 保留** —— 新的 commit handler 本身、bootstrap fixture、admin API 路由都合法使用。未做弃用标记。

### 3.8 SSE 事件与 commit chain 解耦

[`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts) 引入 `wrapStoreWithPluginDataEvents(store, eventBus)` Proxy:

> 在 `setPluginData` / `setPluginDataBatch` / `deletePluginData` 上透明地发出 `plugin-data.changed` 事件,不论调用者是 kernel commit pipeline、guard 钩子、RPC handler 还是 admin 路由。

这一层让前端 SSE 通路与 commit chain 路径**完全解耦** —— 即使 §3.7 的例外路径(guard)直接写 store,面板也能实时刷新。原计划中 `bootstrap.ts:808–815` 的"skip the commit pipeline"警告注释也已随之删除。

---

## 4. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| [`packages/runtime/tests/session-kernel.test.ts`](../../../packages/runtime/tests/session-kernel.test.ts) | `plugin.data` / `plugin.data.batch` 经 commit pipeline 落盘(store round-trip,断言 `setPluginData` / `setPluginDataBatch` 被调) |
| [`packages/runtime/tests/hook-wire-session-kernel.test.ts`](../../../packages/runtime/tests/hook-wire-session-kernel.test.ts) | `PreStateCommit` 能 abort `plugin.data`,store 未写入("blocks plugin.data proposals before they reach the store") |
| [`packages/tools/tests/plugin-data-tools.test.ts`](../../../packages/tools/tests/plugin-data-tools.test.ts) | 内置 tool 返回 `pendingProposals`,**不**再直接调 store;读路径 `plugin-data-get` / `-list` 仍走 store |
| 各插件 `tests/*.test.js` | 各插件的单测通过一个 `applyPendingPluginData(result, store)` helper 把产出的 proposal 回放到 mock store,验证端到端语义 |

**未补**:`apps/server/tests/api/hook-pipeline-integration.test.ts` 原计划的 HTTP 端到端 `plugin.data` 拦截场景尚未覆盖。优先级低,留待出现集成 bug 时补。

---

## 5. 风险复盘

| 风险 | 缓解情况 |
|------|---------|
| ~8 个 core 插件 local tool 可能漏 | grep 闭环 + 每个插件自测套 `applyPendingPluginData` 做 round-trip,无漏 |
| `pendingProposals` 协议破坏下游 ToolAdapter | 改用**非枚举 Symbol carrier**,content 本身不变,旧 adapter `JSON.stringify` 不会泄漏 Symbol,**零破坏** |
| 事务原子性:PG 下多个 plugin-data 写进同一个 txn | 由 `COVEL_COMMIT_TXN_V1` + `setPluginDataBatch` 本身的实现兜底,rollback 粒度即整个 commit |
| 性能:多一层 proposal 间接 | 实测可忽略;batch 路径单 proposal 内部展开,hook 只被调 1 次 |
| 第三方 `store.setPluginData` 调用 | 底层 API 未移除,仅官方推荐路径切走;未出弃用通告 |
| **新出现**:guard 绕过治理 | 有意保留(见 §3.7);经 `wrapStoreWithPluginDataEvents` 仍能观测到,未来如需可治理,另开 ticket |

---

## 6. 交付物验收(已完成)

- [x] `ProposalType` 含 `plugin.data` + `plugin.data.batch`
- [x] `session-kernel` 能 commit 这两类 proposal(`session-kernel.test.ts` round-trip)
- [x] `plugin-data-set` / `plugin-data-set-batch` 改为 `withPendingProposals` 模式
- [x] 全部 core 插件 local tool 迁移完成(`grep -rn "store\.setPluginData\b" plugins/*/tools/` = 0)
- [x] `PreStateCommit` hook 能拦截 `plugin.data`(`hook-wire-session-kernel.test.ts`)
- [x] 文档更新:[`docs/reference/tools.md`](../../../docs/reference/tools.md)(治理路径说明)、[`docs/guide/plugin-authoring.md`](../../../docs/guide/plugin-authoring.md)(local tool 写入约定)
- [x] 新增 [`wrapStoreWithPluginDataEvents`](../../../apps/server/src/routes/api/bootstrap.ts) 让 SSE 与 commit chain 解耦
- [x] `pnpm lint` + `pnpm test` 绿
- [ ] HTTP 端到端集成测试(低优先级,未补)

---

## 7. 关键文件(as-shipped)

- [`packages/shared/src/types/proposal.ts`](../../../packages/shared/src/types/proposal.ts) — `PluginDataPayload` / `PluginDataBatchPayload` 新增
- [`packages/runtime/src/session-kernel.ts`](../../../packages/runtime/src/session-kernel.ts) — `commitPluginData` / `commitPluginDataBatch`
- [`packages/runtime/src/tool-executor.ts`](../../../packages/runtime/src/tool-executor.ts) · [`turn-executor.ts`](../../../packages/runtime/src/turn-executor.ts) — `pendingProposals` 汇聚
- [`packages/tools/src/result.ts`](../../../packages/tools/src/result.ts) — `withPendingProposals` / `getPendingProposals` carrier 协议
- [`packages/tools/src/builtin/plugin-data-tools.ts`](../../../packages/tools/src/builtin/plugin-data-tools.ts) — 内置 tool 改写
- `plugins/core-{codex,guide,world-init,npc-graph}/tools/*.js` — 迁移后的 local tool
- [`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts) — `wrapStoreWithPluginDataEvents` Proxy
- [`docs/reference/tools.md`](../../../docs/reference/tools.md) · [`docs/guide/plugin-authoring.md`](../../../docs/guide/plugin-authoring.md) — 面向插件作者的治理路径说明

---

## 8. 与最初计划的差异

| 维度 | 最初计划(F3 pending 版) | 实际 landed |
|---|---|---|
| Proposal 命名 | `plugin-data.set` / `plugin-data.set-batch` | `plugin.data` / `plugin.data.batch` |
| Payload 字段 | 含 `pluginId` + `expiresAt` | 仅 `namespace` / `key` / `value`;`pluginId` 从 `source` 取,无 `expiresAt` |
| Batch payload 字段名 | `records` | `items` |
| Tool 协议 | 扩展显式 `ToolResult { content, pendingProposals }` | 非枚举 Symbol carrier + `withPendingProposals()` helper(零侵入) |
| SSE 事件路径 | 未涉及 | 新增 `wrapStoreWithPluginDataEvents` Proxy 让 SSE 与 commit chain 解耦 |
| 弃用通告 | 计划文档提示 6 个月弃用窗口 | 未写弃用通告 —— `store.setPluginData` 继续作为合法底层 API,无需弃用 |
| HTTP 集成测试 | 计划含 `hook-pipeline-integration.test.ts` 拦截 case | 未补(低优先级) |

---

## 9. 可选延展(未做,可后续 ticket)

- `plugin-data.delete` 也改为 proposal(当前 delete 路径仍独立)
- 给 `PluginDataPayload` 加 Zod schema 校验,防止插件作者构造畸形 proposal
- `proposal.dry-run` 模式,让 hook 作者测试拦截逻辑
- `apps/server/tests/api/hook-pipeline-integration.test.ts` 补 HTTP 端到端 `plugin.data` 拦截 case
