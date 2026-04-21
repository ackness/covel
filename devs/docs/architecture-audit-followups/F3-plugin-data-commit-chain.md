# F3 · 把 `plugin-data` 写路径纳入统一 commit chain

**Status**: pending · **Est**: 5–7 hours · **Risk**: medium (touches 8 core plugins) · **Depends on**: F1 + F2 landed (已完成)

---

## 1. 背景:为什么需要这个

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

**证据 B** · [`plugins/core-codex/tools/unlock-codex-entries.js:52-80`](../../../plugins/core-codex/tools/unlock-codex-entries.js)

插件的 local tool 也这样写:

```js
// 每个 entry 直接 setPluginData
await context.store.setPluginData({
  sessionId: context.sessionId,
  pluginId: 'core-codex',
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

## 2. 目标

**一句话**:让 `plugin-data-set` 和 `plugin-data-set-batch` 两个内置工具从"直接写 store"改为"提交 proposal",从而继承 commit chain 的全部治理能力。同时保留 `store.setPluginData()` 作为**底层 API**,供 commit handler 本身调用。

---

## 3. 实施方案

### 3.1 阶段 1 · Proposal 类型 + commit handler(~2h)

#### 3.1.1 `@covel/shared`

在 [`packages/shared/src/types/proposal.ts`](../../../packages/shared/src/types/proposal.ts) 加:

```ts
export interface PluginDataSetPayload {
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  /** ISO timestamp; null/undefined means no expiry. */
  readonly expiresAt?: string | null;
}

// ProposalType 联合加一条
export type ProposalType =
  | 'narrative.append'
  | 'state.patch'
  | 'event.emit'
  | 'record.upsert'
  | 'ui.render'
  | 'asset.generate'
  | 'lorebook.upsert'
  | 'plugin-data.set';  // 新增
```

[`packages/shared/src/types/index.ts`](../../../packages/shared/src/types/index.ts) 的 barrel export 加 `PluginDataSetPayload`。

#### 3.1.2 `@covel/runtime` commit handler

在 [`packages/runtime/src/session-kernel.ts`](../../../packages/runtime/src/session-kernel.ts) 的 `handlers` 表里加:

```ts
const handlers: Record<ProposalType, (p: Proposal) => Promise<CommitResult>> = {
  // ...existing
  'plugin-data.set': commitPluginDataSet,
};

async function commitPluginDataSet(proposal: Proposal): Promise<CommitResult> {
  const p = proposal.payload as PluginDataSetPayload;
  try {
    await store.setPluginData({
      sessionId: proposal.sessionId,
      pluginId: p.pluginId,
      namespace: p.namespace,
      key: p.key,
      value: p.value,
      expiresAt: p.expiresAt ?? null,
    });
    return { committed: true };
  } catch (err) {
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

关键:这个 handler 位于 `commit()` 函数的**下方**,也就是说 `PreStateCommit` hook **已经**拦截过了,后续走完整 trace + txn 流程。

#### 3.1.3 Batch 的选择

两种做法:

- **A**: 保留 `plugin-data-set-batch` 作为一个独立 proposal type `plugin-data.set-batch`,payload 带数组。优点:一次 commit,事务性好。
- **B**: batch 工具内部展开成 N 个 `plugin-data.set` proposal。优点:proposal 粒度统一;缺点:1000 个 entry 时 hook 被调 1000 次,性能差。

**推荐 A**。新增 `PluginDataSetBatchPayload { records: readonly PluginDataSetPayload[] }` 和对应 handler。

### 3.2 阶段 2 · Tool 侧切换(~2h)

#### 3.2.1 难点:tool 本来不返回 proposal

Covel 目前的 ToolExecutor 约定 tool 返回值是直接给 LLM 看的 `{ ok: true, ... }`,tool 本身无法 emit proposal —— proposal 只有 runtime(agent runner 或 function runner)结束时产生。

需要扩展 ToolExecutor 协议:**tool 可以声明 pending proposals**。

在 [`packages/runtime/src/tool-executor.ts`](../../../packages/runtime/src/tool-executor.ts)(具体行号实施时查)的 `ToolResult` 类型加:

```ts
export interface ToolResult {
  readonly content: unknown;       // 返给 LLM 的可见结果
  readonly pendingProposals?: readonly Proposal[];  // 新增:落盘由 commit chain 接管
}
```

Agent runtime 的 tool 循环 / function runtime 调用 tool 后,把 `pendingProposals` 累积到 `runtime result.proposals` 末尾。Commit chain 负责真正落盘。

#### 3.2.2 改 `plugin-data-tools.ts`

```ts
export const pluginDataSetTool: BuiltinTool = {
  name: 'plugin-data-set',
  execute: async ({ pluginId, namespace, key, value, expiresAt }, ctx) => {
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      type: 'plugin-data.set',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: { kind: 'tool', name: 'plugin-data-set', runtimeId: ctx.runtimeId },
      payload: { pluginId, namespace, key, value, expiresAt },
      createdAt: new Date().toISOString(),
    };
    return {
      content: { ok: true, queued: true },
      pendingProposals: [proposal],
    };
  },
};
```

**向 LLM 隐藏的变化**:结果仍然是 `{ ok: true }`,插件作者无感。

### 3.3 阶段 3 · 迁移 core 插件的 local tool(~1–2h)

需要走查并改写的插件 local tool 清单(grep `store.setPluginData\|context.store.setPluginData`):

- [`plugins/core-codex/tools/unlock-codex-entries.js`](../../../plugins/core-codex/tools/unlock-codex-entries.js)
- [`plugins/core-guide/tools/generate-guide.js`](../../../plugins/core-guide/tools/generate-guide.js)(若有 plugin-data 写)
- `plugins/core-char-creator/**` / `plugins/core-world-init/**`(若有)
- 其他:grep 结果为准

每个 tool 的改动都是**同样的模式**:从 `await context.store.setPluginData(...)` 改成 `return { content: {...}, pendingProposals: [{ type: 'plugin-data.set', payload: {...} }] }`。

### 3.4 阶段 4 · 兼容层 + 弃用通告(~1h)

- `store.setPluginData()` 保留作为 runtime internal API,不再向 tool 作者暴露。
- 在 [`docs/reference/tools.md`](../../../docs/reference/tools.md) 的 `plugin-data-*` 小节加"**写入现在走 commit chain,受 PreStateCommit 影响**"的说明。
- 在 [`docs/guide/plugin-authoring-advanced.md`](../../../docs/guide/plugin-authoring-advanced.md) 写一个短小节:"如果你的 local tool 直接写 store,迁移到 `pendingProposals` 模式"。
- 不立即删除 `store.setPluginData` 的公共 export —— 第三方插件可能直接调用。留 6 个月弃用窗口,下次 major bump 删。

### 3.5 阶段 5 · 测试(~1h)

新增测试:

1. `packages/runtime/tests/session-kernel.test.ts` — 断言 `plugin-data.set` proposal 提交后 store 可读。
2. `packages/runtime/tests/session-kernel.test.ts` — 挂一个 `PreStateCommit` hook 拦截 `plugin-data.set`,断言被拒后 store 不变。
3. `apps/server/tests/api/hook-pipeline-integration.test.ts` 扩展一个 case:走 HTTP 路径 → 插件 tool 发 `plugin-data.set` → hook 拦下 → 玩家看到合适错误。
4. `packages/tools/tests/plugin-data-tools.test.ts`(新)— 断言 tool 现在返回 `pendingProposals`,不再直接写 store。

---

## 4. 风险清单

| 风险 | 缓解 |
|------|------|
| ~8 个 core 插件的 local tool 要改,有可能漏 | 用 `grep -rn "store.setPluginData\b" plugins/` 列完整清单;每改完一个跑对应插件的单测 |
| `pendingProposals` 协议破坏下游 ToolExecutor 的用户(第三方 ToolAdapter) | `pendingProposals` 标 `readonly` 且 optional,旧 adapter 忽略即可;新增字段不破坏 |
| 事务原子性:PG 下多个 plugin-data 写进同一个 txn,单 key 冲突时回滚粒度 | 使用现有 `COVEL_COMMIT_TXN_V1` 路径即可,它已经处理 rollback |
| 性能:多了一层 proposal 间接 | 实测单 commit < 1ms;batch 走单 proposal(3.1.3 选项 A)解决大批量 |
| 第三方插件靠直接 `store.setPluginData` | 兼容层保留,只是 ~~官方推荐~~ 改为 proposal 模式 |

---

## 5. 交付物验收

- [ ] `ProposalType` 含 `plugin-data.set` + `plugin-data.set-batch`
- [ ] `session-kernel` 能正确 commit 这两类 proposal(附 store round-trip 测试)
- [ ] `plugin-data-set` / `plugin-data-set-batch` 两个内置工具改为 pendingProposals 模式
- [ ] 所有 core 插件 local tool 迁移完成(grep `store.setPluginData` 在 `plugins/` 下为 0 命中)
- [ ] `PreStateCommit` hook 能拦截 `plugin-data.set`(含集成测试)
- [ ] 文档更新:`docs/reference/tools.md`、`docs/guide/plugin-authoring-advanced.md`
- [ ] `pnpm lint` + `pnpm test` 全绿

---

## 6. 参考文件清单

实施时必读:

- [`packages/shared/src/types/proposal.ts`](../../../packages/shared/src/types/proposal.ts) — ProposalType 定义
- [`packages/runtime/src/session-kernel.ts`](../../../packages/runtime/src/session-kernel.ts) — commit chain + handlers
- [`packages/runtime/src/tool-executor.ts`](../../../packages/runtime/src/tool-executor.ts) — ToolResult 协议
- [`packages/tools/src/builtin/plugin-data-tools.ts`](../../../packages/tools/src/builtin/plugin-data-tools.ts) — 要改写的工具
- [`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts) — 注释里的警告源头
- 审计原始记录:`audits/2026-04-21-architecture-code-audit/README.md`(审计原始产出,本地 gitignored) 第 3 节

## 7. 可选延展(不在本 ticket 范围)

- `plugin-data.delete` 也改为 proposal(当前的 delete 路径是独立的,可在后续 ticket 统一)
- 给 proposal 加 schema 验证:`payload` 通过 Zod schema 检查,防止插件作者构造畸形 proposal
- 引入 `proposal.dry-run` 模式,让 hook 作者测试拦截逻辑
