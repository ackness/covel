# 02 · Hook payload middleware 语义收敛

> **状态**：P1 refine · 2026-04-27 结合代码库重写
> **借鉴源**：pi-mono `tool_call` in-place mutate、`tool_result` partial patch middleware
> **影响范围**：`packages/runtime/src/hooks/*` · `packages/shared/src/types/plugin.ts` hook docs · `docs/reference/plugins.md` · `docs/reference/protocol.md`
> **外部依赖**：无

---

## § 0.0 当前评审结论

（待入。本节预留，外部评审落地后将原文引用 + 在正文加 `评审 #N 修正` marker。）

---

## § 0 为什么写这份文档

最初 README 把本项写成“Hook 链 middleware 语义化 backlog”。结合当前代码库后，这个描述需要修正：**Covel 已经有 HookPipeline，不是从零设计 hook middleware**。

当前实现位于：

- `packages/runtime/src/hooks/types.ts`
- `packages/runtime/src/hooks/pipeline.ts`
- `packages/runtime/src/hooks/wire-helpers.ts`
- `packages/runtime/src/hooks/register-plugin-hooks.ts`

已经具备：

```ts
export type HookSemantic = 'first' | 'sequential' | 'parallel' | 'stream';

export const HOOK_SEMANTICS: Record<HookEvent, HookSemantic> = {
  TurnStart: 'parallel',
  PreRuntime: 'sequential',
  PostRuntime: 'parallel',
  PreToolUse: 'sequential',
  PostToolUse: 'parallel',
  PreStateCommit: 'sequential',
  PostStateCommit: 'parallel',
  TurnStop: 'parallel',
};
```

`HookResult` 也已经是：

```ts
type HookResult<P> =
  | { action: 'continue' }
  | { action: 'continue'; replace: Partial<P> }
  | { action: 'abort'; reason: string };
```

所以本提案的目标不是“新增 HookPipeline”，而是**把 payload patch、validation、parallel 返回值、trace diff、PostToolUse 是否可 patch 等语义钉死**，避免插件作者误解。

---

## § 1 现状盘点

### 1.1 已有顺序语义

`HookPipeline.runSequential()` 当前逻辑：

1. handler 按 `enforce: pre → normal → post` 排序；
2. 每个 handler 看到前一个 handler patch 后的 `currentPayload`；
3. handler 返回 `replace` 时 shallow merge；
4. handler 返回 `abort` 时中止；
5. 最终返回 accumulated partial patch。

这已经非常接近 pi 的 middleware chain，但 Covel 用 `replace` 而不是 mutable event。

### 1.2 已有 trace 语义

`pipeline.ts` 里已经会发：

- `hook.fired`
- `hook.rewrote`
- `hook.aborted`
- `hook.error`
- `hook.timeout`

`hook.rewrote` 记录：

```ts
diff: { before, after }
```

这比 pi 的 in-place mutation 更适合服务器端审计。

### 1.3 当前未钉死的问题

| 问题 | 当前风险 |
|---|---|
| `replace` 是 shallow merge，嵌套对象如何处理未文档化 | 插件作者可能以为是 deep merge |
| `PreToolUse` patch 后是否重新做 tool schema validation 未明确 | patch 可能产生 invalid tool input |
| `PreToolUse` 是否允许改 `toolName` 未明确 | 可能破坏 tool access / approval 语义 |
| `PostToolUse` 当前是 `parallel`，handler 返回 `replace` 是否会被使用不直观 | 插件作者可能以为能改 tool result |
| `PostRuntime` / `PostStateCommit` 是 parallel，返回值语义不明显 | parallel hooks 目前基本只能 observe |
| `stream` semantic 类型存在，但当前按 sequential fallback | 容易造成“已有 stream transform”的误解 |

---

## § 2 设计目标

1. 保留 Covel 当前 `replace/abort` 模式，不照搬 pi 的 mutable event。
2. 明确每个 hook event 的 payload 是否可改、怎么改、是否重新校验。
3. 明确 parallel hooks 是 observe-only，除非未来为某个 event 显式声明 reduce 规则。
4. 明确 `PreToolUse` 的安全边界：可以 patch input，不能换 tool identity。
5. 给 docs 和 trace viewer 一个稳定解释：hook rewrite 是 shallow patch，不是 deep patch。
6. 保持框架 ↔ 插件分离：HookPipeline 只理解通用 payload、tool identity、proposal envelope，不内置任何插件 ID 或玩法规则。

---

## § 3 边界（Non-goals）

- 不新增新的 hook lifecycle 点；`PreInput` 另见 `03-pre-input-hook.md`。
- 不改 hook 注册 frontmatter 主结构。
- 不引入 arbitrary JavaScript event mutation。
- 不把 parallel hooks 改成默认可写；并行写入需要明确 reducer，否则不确定。
- 不把 hook 当 gameplay 逻辑承载层；hook 仍用于 guard / rewrite / audit。
- 不允许框架 hook pipeline 根据具体插件 ID、runtime ID、namespace 写特例逻辑；需要差异化行为时，由插件自己的 hook 声明和 match 条件表达。

---

## § 4 总体架构

推荐语义表：

| Hook | 当前 semantic | 建议语义 | 是否允许 replace | 备注 |
|---|---|---|---|---|
| `TurnStart` | parallel | observe-only | 否 | 初始化审计、trace、metrics |
| `PreRuntime` | sequential | patch chain | 是 | 可改 runtime payload，例如 prompt adjunct / config view；需文档化字段 |
| `PostRuntime` | parallel | observe-only | 否 | 不应用 replace；runtime output rewrite 应走专门 proposal/hook |
| `PreToolUse` | sequential | patch chain + abort | 是 | 只能改 tool input，不能改 toolName/tool identity |
| `PostToolUse` | parallel | P1 可升级为 sequential patch chain | 暂否 / 待升级 | pi 的 `tool_result` patch 最适合映射到这里 |
| `PreStateCommit` | sequential | proposal patch chain + abort | 是 | commit 前 guard/rewrite 主入口 |
| `PostStateCommit` | parallel | observe-only | 否 | commit 后 audit / side-effect signal |
| `TurnStop` | parallel | observe-only | 否 | 清理、metrics |

---

## § 5 详细设计

### 5.1 明确 shallow replace 规则

**当前问题**

`runSequential()` 使用：

```ts
Object.assign(accumulated, result.replace);
currentPayload = { ...currentPayload, ...result.replace };
```

这是 shallow merge。

**提议方案**

文档和类型注释明确：

- `replace` 是 shallow patch；
- 嵌套对象需要整体替换；
- 不支持 JSON Patch / deep merge；
- handler 看到的是前序 handler patch 后的 payload。

**后续可选**

如果某个 event 需要结构化 deep patch，单独为 payload 字段设计，例如：

```ts
{ replace: { proposal: nextProposal } }
```

而不是让 hook pipeline 全局 deep merge。

### 5.2 `PreToolUse` 只允许 patch input，不允许换 tool identity

**当前问题**

需要确认 wire-helper 对 `PreToolUse` payload 的应用方式。如果 payload 包含 `toolName`，理论上 handler 可能尝试 patch。

**提议方案**

规定：

- `PreToolUse.replace` 只应用到 `input` / `args` 字段；
- `toolName`、`toolCallId`、`pluginId`、`runtimeId` 是 identity 字段，不接受 replace；
- 如果 hook 返回 identity 字段 patch，框架忽略并发 `hook.rewrite.ignored` trace，或直接 abort（待实现时二选一）。

推荐 fail-fast：

```ts
return { action: 'abort', reason: 'PreToolUse cannot replace toolName/toolCallId' }
```

理由：工具 identity 影响 tool access、approval、local tool scope，不能被 hook 绕过。

### 5.3 `PreToolUse` patch 后重新校验 tool schema

**当前问题**

pi 文档明确：tool_call mutation 后不重新 validation。Covel 不应照搬，因为 Covel 有 server-side governance。

**提议方案**

`PreToolUse` patch 后：

1. 重新用 tool schema 校验 input；
2. 重新执行 approval policy 中依赖 input 的部分；
3. 不重新 resolve toolName；
4. 校验失败时 tool call 失败，trace `hook.rewrite.invalid`。

这比 pi 更安全，符合 Covel trust tier。

### 5.4 `PostToolUse` 是否升级为 sequential patch chain

**当前问题**

pi 的 `tool_result` 支持 partial patch chain，非常适合：

- redact sensitive result；
- summarize huge result；
- normalize tool error；
- attach trace details。

Covel 现在 `PostToolUse` 是 parallel，返回 patch 没有天然合并意义。

**提议方案**

P1-a：文档明确当前 `PostToolUse` observe-only，replace 不应用。

P1-b：如确有需求，把 `PostToolUse` 改成 sequential：

```ts
PostToolUse: 'sequential'
```

并定义 patchable 字段：

```ts
content/result/details/isError
```

不允许 patch identity：

```ts
toolName/toolCallId/pluginId/runtimeId
```

**兼容性**

parallel → sequential 会改变 handler 执行时序。如果已有插件只观察，不受影响；如果已有插件依赖并发 side effect，需文档提示。

### 5.5 parallel hooks 返回值规则

**当前问题**

`runParallel()` 当前忽略 fulfilled results，只记录 rejected errors，最终：

```ts
return { action: 'continue' };
```

这应该正式化。

**提议方案**

规定：

- parallel hooks 是 observe-only；
- fulfilled `replace` 被忽略，并发 `hook.replace.ignored` debug trace（可选）；
- fulfilled `abort` 不影响主流程，只记录 `hook.aborted`（当前 invokeHandler 已会 emit）；
- 只有 sequential / first hooks 能改变控制流。

如未来某个 parallel event 需要多个结果 reduce，必须显式定义 reducer，不能默认 merge。

---

## § 6 迁移计划

### P1-a · 文档与注释

- 更新 `packages/runtime/src/hooks/types.ts` 注释：shallow replace、parallel observe-only。
- 更新 `docs/reference/plugins.md` hook 章节。
- 更新 `docs/reference/protocol.md` hook trace event 说明。

### P1-b · PreToolUse 安全边界

- 审查 `runPreToolUseHook` 应用 replace 的逻辑。
- 禁止 identity field patch。
- patch 后重新 schema validation。
- 增加 tests。

### P1-c · PostToolUse patch chain 评估

- 搜索现有 hook 使用者。
- 如果没有并发依赖，将 `PostToolUse` 改为 sequential。
- 增加 tool result redaction / summarize 测试。

---

## § 7 风险 / Tradeoffs

| 风险 | 缓解 |
|---|---|
| PostToolUse parallel 改 sequential 改变时序 | 先 P1-a 文档化 observe-only；P1-c 单独评审 |
| 重新 validation 增加少量成本 | tool schema 校验成本远低于 LLM/tool call，值得 |
| 禁止 patch toolName 限制灵活性 | 工具替换应通过 registry/activation/approval，不应由 hook 偷换 |

---

## § 8 是否必须现在做？

不如 #01/#03 紧急，因为 HookPipeline 已可用。但越晚文档化，第三方 plugin 越可能误解 parallel hook / replace 语义。

建议 P1 做：先文档化，再决定是否升级 PostToolUse。

---

## § 9 待决问题

1. `PreToolUse` identity patch 是忽略还是 abort？倾向 abort。
2. `PostToolUse` 是否从 parallel 改 sequential？需先盘点现有 hook 插件。
3. 是否新增 `hook.replace.ignored` trace subtype？可选。
4. schema validation 放在 hook wire-helper 还是 ToolExecutor？倾向 ToolExecutor，保证所有调用路径一致。

---

## § 10 下一步

1. 盘点 `runPreToolUseHook` / `runPostToolUseHook` 当前 payload shape。
2. 更新 hook docs，先不改行为。
3. 为 `PreToolUse` patch identity 写 failing test。
4. 决策 `PostToolUse` 是否进入 sequential patch chain。
