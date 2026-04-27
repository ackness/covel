# 11 · Context budget breakdown

> **状态**：P0/P1 proposed · 2026-04-27 结合代码库起草
> **借鉴源**：pi-mono `ctx.getContextUsage()` 与 footer context usage；但 Covel 需要 segment/plugin 级归因
> **影响范围**：`packages/context/src/{budget,prompt-internals,context-builder,prompt-assembler}.ts` · `packages/runtime/src/turn-executor.ts` · trace/protocol · debug Prompt Viewer
> **外部依赖**：#01 plugin-data visibility 推荐先行或并行

---

## § 0.0 当前评审结论

（待入。本节预留，外部评审落地后将原文引用 + 在正文加 `评审 #N 修正` marker。）

---

## § 0 为什么写这份文档

Covel 已经有 token budget pruning，但缺“上下文预算由谁消耗”的可观测性。

当前 `packages/context/src/budget.ts` 已有：

```ts
export interface BudgetOptions {
  readonly maxInputTokens: number;
  readonly reservedForResponse?: number;
  readonly protectLastUserTurns?: number;
  readonly estimator: TokenEstimator;
}

export interface BudgetResult<M> {
  readonly messages: readonly M[];
  readonly totalTokens: number;
  readonly prunedMessageCount: number;
  readonly budgetExceeded: boolean;
}
```

这能回答：

- 是否超预算；
- 总 token 估算；
- 裁了多少历史消息。

但不能回答：

- `PLUGIN.md` body 花了多少；
- `plugin-data inject` 花了多少；
- 哪个 namespace 最贵；
- world/lorebook/working-memory/core-memory 花了多少；
- V2 segment 9 authorsNote / segment 10 postHistory 花了多少；
- #01 的 `context-summary` 是否真的省 token；
- prompt viewer 里为什么某个 turn 变贵。

pi 的 `getContextUsage()` 是单 agent 的总量视图；Covel 需要更细，因为 Covel 是多 runtime、多 plugin、多 context slice。

---

## § 1 现状盘点

### 1.1 Budget pruning 已存在

`applyBudget(systemPrompt, messages, options)` 会根据：

- `maxInputTokens`
- `reservedForResponse`
- `protectLastUserTurns`
- `estimator`

裁剪 message history。

### 1.2 ContextBuildParams 已穿透 estimator/budget

`packages/context/src/types.ts`：

```ts
readonly estimator?: TokenEstimator;
readonly contextBudget?: Omit<BudgetOptions, 'estimator'>;
```

`packages/runtime/src/turn-executor.ts` 也有 deps：

```ts
readonly estimator?: TokenEstimator;
readonly contextBudget?: Omit<BudgetOptions, 'estimator'>;
```

### 1.3 Prompt assembly 已有多个隐含 segment

从 `prompt-internals.ts` 和 context docs 可见，prompt 来源包括：

- framework preamble；
- runtime `promptTemplate`；
- runtime inject；
- plugin-data inject；
- world config variables；
- player character；
- message history；
- summaries；
- working memory；
- core memory；
- authorsNote；
- postHistory。

但这些最终大多拼成一个 `systemPrompt` 字符串，budget 只看总量。

---

## § 2 设计目标

1. 不重做 `applyBudget()`；保留现有 pruning。
2. 在 prompt assembly 阶段产出 segment-level token breakdown。
3. breakdown 能归因到 runtime/plugin/namespace/visibility。
4. trace/SSE/debug 可消费，普通 runtime 行为零变化。
5. 与 #01 `plugin_data.visibility/summary` 联动，展示 private 不进 prompt、summary 节省量。
6. feature flag 渐进启用，避免影响基线 prompt 字节稳定性。
7. 保持框架 ↔ 插件分离：budget breakdown 只统计通用 segment，不根据具体插件 ID 赋予特殊预算或特殊裁剪规则。

---

## § 3 边界（Non-goals）

- 不引入真实 tokenizer 依赖；继续使用 caller 注入的 `TokenEstimator`。
- 不在 P0 做自动 budget 分配策略，只观测。
- 不让 plugin 自己决定全局 prompt budget；plugin 只可看到只读 budget view（后续）。
- 不改变 compactor 策略。
- 不改变 `applyBudget()` 的裁剪算法。
- 不做 `core-codex`、`core-memory` 等插件特例预算；如果某插件需要预算上限，应通过 manifest/visibility/namespace 通用声明表达。

---

## § 4 总体架构

新增类型：

```ts
export interface ContextBudgetSegment {
  readonly id: string;
  readonly kind:
    | 'framework'
    | 'plugin-prompt'
    | 'runtime-inject'
    | 'plugin-data-inject'
    | 'world'
    | 'memory'
    | 'lorebook'
    | 'history'
    | 'summary'
    | 'authors-note'
    | 'post-history'
    | 'tool-definitions'
    | 'unknown';
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly namespace?: string;
  readonly visibility?: 'private' | 'context-summary' | 'context-full';
  readonly charCount: number;
  readonly estimatedTokens: number;
  readonly truncated?: boolean;
  readonly entryCount?: number;
  readonly renderedEntryCount?: number;
}

export interface ContextBudgetBreakdown {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly maxInputTokens?: number;
  readonly reservedForResponse?: number;
  readonly totalEstimatedTokens: number;
  readonly systemPromptTokens: number;
  readonly messageTokens: number;
  readonly prunedMessageCount?: number;
  readonly budgetExceeded?: boolean;
  readonly segments: readonly ContextBudgetSegment[];
}
```

`AssembledContext` 可扩展：

```ts
export interface AssembledContext {
  readonly systemPrompt: string;
  readonly messages: readonly LLMMessage[];
  readonly budgetBreakdown?: ContextBudgetBreakdown;
}
```

---

## § 5 详细设计

### 5.1 Segment recorder

新增内部 helper：

```ts
interface SegmentRecorder {
  add(input: {
    id: string;
    kind: ContextBudgetSegment['kind'];
    text: string;
    pluginId?: string;
    runtimeId?: string;
    namespace?: string;
    visibility?: PluginDataVisibility;
    truncated?: boolean;
    entryCount?: number;
    renderedEntryCount?: number;
  }): void;
  finalize(...): ContextBudgetBreakdown;
}
```

只有当 `estimator` 存在并且 feature flag 开启时记录；否则零开销或近零开销。

建议 flag：

```bash
COVEL_CONTEXT_BUDGET_BREAKDOWN=1
```

### 5.2 plugin-data inject segment

`resolvePluginDataInject()` 当前生成 XML block。这里是最适合记录的点。

当前：

```ts
const entries = await params.store.listPluginData(...);
const truncated = twoPassTruncate(entries, maxEntries);
const serialized = escapeXmlContent(serializeEntries(truncated, format));
return `<${tagName}>\n${serialized}${countLine}\n</${tagName}>`;
```

改造后记录：

```ts
segmentRecorder.add({
  id: `plugin-data:${params.manifest.pluginId}:${inject.namespace}`,
  kind: 'plugin-data-inject',
  pluginId: params.manifest.pluginId,
  runtimeId: params.manifest.name,
  namespace: inject.namespace,
  text: block,
  entryCount: entries.length,
  renderedEntryCount: truncated.length,
  truncated: entries.length > truncated.length,
});
```

如果 #01 已落地，附加：

```ts
visibility: 'context-summary' | 'context-full'
```

private 行不应出现在 segment 中；debug 可显示 filtered count。

### 5.3 V1 / V2 prompt assembly 兼容

V1 `context-builder.ts` 可能是单字符串拼接；V2 `prompt-assembler.ts` 已有 segment 1-10 概念。

建议：

- P0 支持 plugin-data inject + history + whole system prompt 总量；
- P1 支持 V2 segment 细分；
- V1 不强求完全拆分，只记录 coarse segment。

### 5.4 trace event

新增 trace subtype：

```ts
context.budget
```

payload：

```ts
{
  runtimeId,
  pluginId,
  totalEstimatedTokens,
  systemPromptTokens,
  messageTokens,
  prunedMessageCount,
  budgetExceeded,
  segments: [...]
}
```

在 `turn-executor` build context 后、LLM call 前 emit。

### 5.5 Debug Prompt Viewer

前端 `/debug` Prompt Viewer 可展示：

- total tokens；
- system vs messages；
- top segments by token；
- plugin-data namespace cost；
- truncated flag；
- summary/full visibility；
- pruned history count。

这能直接验证 #01 的效果。

### 5.6 Plugin-facing只读预算视图（P2）

未来可给 function runtime / guard 一个只读 view：

```ts
ctx.contextBudget?: {
  remainingForInjects: number;
  lastTurnBreakdown?: ContextBudgetBreakdown;
}
```

P0/P1 不做，避免 plugin 依赖不稳定内部预算。

---

## § 6 迁移计划

### P0-a · 类型与 recorder

- `packages/context/src/types.ts` 新增 `ContextBudgetSegment` / `ContextBudgetBreakdown`。
- `AssembledContext` 加 optional `budgetBreakdown`。
- 新增 internal recorder helper。

### P0-b · plugin-data inject 归因

- `resolvePluginDataInject()` 记录 namespace segment。
- 如果 #01 未落地，visibility 留空。
- tests：maxEntries truncation 后 segment.entryCount/renderedEntryCount 正确。

### P0-c · trace 输出

- `turn-executor` 在 LLM call 前 emit `context.budget`。
- `apps/server/src/routes/api/actions.ts` SSE forwarded subtype 加 `context.budget`（如需要实时 debug）。
- protocol docs 更新。

### P1 · V2 segment 细分 + debug UI

- V2 prompt assembler 按 10 slices 记录 segment。
- Prompt Viewer 显示 breakdown。
- 与 #01 visibility 联动显示 private filtered count / summary savings。

---

## § 7 风险 / Tradeoffs

| 风险 | 缓解 |
|---|---|
| 记录 segment 改变 prompt 字节 | recorder 只旁路记录，不参与拼接；tests 保证 prompt byte-identical |
| token 估算不准 | 明确是 estimator-based，用于归因不是计费 |
| trace payload 太大 | segment 只存 metadata 和 token 数，不存完整文本；debug 需要文本从 Prompt Viewer 另取 |
| V1/V2 双路径复杂 | P0 先 coarse；P1 再 V2 精细化 |

---

## § 8 是否必须现在做？

建议与 #01 并行或紧随其后。plugin-data visibility 的价值需要可观测性证明；否则只能凭感觉说 prompt 变短。Context budget breakdown 能让 `/debug` 直接显示：哪个 namespace、哪个 plugin、哪个 segment 最贵。

---

## § 9 待决问题

1. trace payload 是否包含 segment text？倾向不包含，避免泄漏和大 payload。
2. feature flag 名称：`COVEL_CONTEXT_BUDGET_BREAKDOWN` 是否合适？
3. `context.budget` 是否走 SSE action stream？debug 模式需要；普通模式可只入 trace DB。
4. V1 是否值得完全拆 segment？倾向不值得，V2 才精细。

---

## § 10 下一步

1. 加 types + no-op recorder，保证行为不变。
2. 在 plugin-data inject 处记录第一个真实 segment。
3. turn-executor 发 trace event。
4. Prompt Viewer 消费 trace event。
