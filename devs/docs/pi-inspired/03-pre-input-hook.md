# 03 · PreInput 钩子

> **状态**：P0 proposed · 2026-04-27 结合代码库起草
> **借鉴源**：pi-mono `input` event：`continue` / `transform` / `handled`
> **影响范围**：`apps/server/src/routes/api/actions.ts` · `packages/runtime/src/hooks/*` · `packages/shared/src/types/plugin.ts` · `packages/store/src/types.ts` InteractionRecord · `docs/reference/api.md` · `docs/reference/protocol.md`
> **外部依赖**：无

---

## § 0.0 当前评审结论

（待入。本节预留，外部评审落地后将原文引用 + 在正文加 `评审 #N 修正` marker。）

---

## § 0 为什么写这份文档

Covel 当前玩家输入进入 turn pipeline 前缺一个统一拦截点。

`apps/server/src/routes/api/actions.ts` 现在的路径是：

```ts
const playerMessage = type === 'start_session'
  ? ''
  : (payload.content as string) ?? (payload.command as string) ?? '';
```

随后：

1. 写 `messages` 表；
2. 写 `InteractionRecord`；
3. 创建 trace/emitter；
4. 调用 `executeTurn(...)`。

这意味着所有输入都会直接变成 `TurnInput.playerMessage`，再进入 trigger router / scheduler / runtime prompt。

但游戏输入比 coding-agent prompt 更复杂：

- 玩家自然语言：“我去探索沼泽”；
- 快捷命令：“/roll d20”、“/inventory”；
- UI block submit：“我选 A”、“提交角色表单”；
- GM/debug 指令；
- plugin RPC action；
- 外部事件触发；
- 需要被重写、拒绝、或直接处理的输入。

pi 的 `input` event 提供了一个很好的形状：在技能/template expansion 和 agent loop 前，允许 extension `continue / transform / handled`。落到 Covel，应是 **PreInput hook**：在 action request 变成持久 message 和 turn execution 之前，允许 framework/plugin 做结构化路由。

---

## § 1 现状盘点

### 1.1 `actions.ts` 当前无输入前置拦截

支持 action：

```ts
const SUPPORTED_ACTIONS = [
  'send_message',
  'execute_command',
  'trigger_event',
  'start_session',
  'retry_runtime',
];
```

但这些 action 统一被压成 `playerMessage`，没有 hook 能：

- 改写 message；
- 阻止进入 LLM；
- 直接返回 UI event；
- 将输入变成 plugin-rpc；
- 将输入排队到 follow-up/background。

### 1.2 已有 InteractionRecord，可承载 PreInput 结果

`packages/store/src/types.ts` 已有：

```ts
export interface InteractionRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly timestamp: string;
  readonly source: string;
  readonly channel: string;
  readonly type: string;
  readonly targetPluginId?: string;
  readonly targetRuntimeId?: string;
  readonly payload: unknown;
  readonly metaData?: unknown;
  readonly createdAt: string;
}
```

这适合记录：

- 原始 input；
- transform 后 input；
- handled/rejected 原因；
- 哪个 hook/plugin 处理。

### 1.3 现有 HookContext 支持 runtimeId 为空

`packages/runtime/src/hooks/types.ts`：

```ts
export interface HookContext {
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId?: string;
  readonly runtimeId?: string;
}
```

`runtimeId` 已是 optional，所以 `PreInput` 可作为 session-level hook 加入，不需要绑定某个 runtime。

---

## § 2 设计目标

1. 在 `actions.ts` 持久化 message / 调用 `executeTurn` 前提供输入拦截点。
2. 支持四类结果：`continue`、`transform`、`handled`、`reject`。
3. transform 可串联；handled/reject first-wins。
4. 所有结果都写入 `InteractionRecord`，保证 replay/debug 完整。
5. 不让 PreInput 绕过 trust tier：community plugin 的 PreInput hook 必须来自已激活/已批准 plugin。
6. 不让 PreInput 直接写 DB；需要写状态时仍通过 proposal、plugin RPC、或 scoped pluginData writer。
7. 保持框架 ↔ 插件分离：actions route 只运行通用 PreInput pipeline，不按具体插件 ID/命令文本写死玩法分支。

---

## § 3 边界（Non-goals）

- 不替代 `trigger.type = event`；PreInput 发生在 turn 前，event trigger 发生在 runtime scheduling 中。
- 不替代 plugin-rpc；PreInput 可以把输入路由为 plugin-rpc，但不是 RPC handler 本身。
- 不引入 pi 的 skills/template expansion 到游戏 runtime。
- 不支持 community plugin 在未激活时全局截获玩家输入。
- 不允许 PreInput 直接访问全量 DataStore 写接口。
- 不在框架层内置 `/roll`、`/inventory`、`/gm` 等具体玩法命令；这些应由插件通过 PreInput hook / rpc / event 声明实现。

---

## § 4 总体架构

```
POST /api/actions
    │
    ▼
parse ActionRequest
    │
    ▼
PreInput hook chain
    │
    ├── continue ───────► persist message + InteractionRecord ─► executeTurn
    │
    ├── transform ──────► update playerMessage/payload ────────► next hook / executeTurn
    │
    ├── handled ────────► persist InteractionRecord ───────────► emit SSE + execution.completed(no turn)
    │
    └── reject ─────────► persist InteractionRecord ───────────► error.occurred / 4xx
```

建议新增 hook event：

```ts
export type HookEvent =
  | 'PreInput'
  | 'TurnStart'
  | ...;
```

语义：

```ts
HOOK_SEMANTICS.PreInput = 'first-transform'; // 新语义，或复用 sequential + 特殊 result
```

为了避免污染通用 `HookResult<P>`，也可以单独实现 `runPreInputHooks()`，内部复用 handler ordering / timeout / trace。

---

## § 5 详细设计

### 5.1 PreInput payload

```ts
export interface PreInputPayload {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly actionType: 'send_message' | 'execute_command' | 'trigger_event' | 'start_session' | 'retry_runtime';
  readonly source: 'player' | 'ui' | 'rpc' | 'system';
  readonly channel: 'web' | 'desktop' | 'api' | 'test';
  readonly locale: string;
  readonly modelOverride?: string;
  readonly playerMessage: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
```

### 5.2 PreInput result

建议不要复用通用 `HookResult`，因为 `handled/reject` 是 input 特有控制流：

```ts
export type PreInputResult =
  | { readonly action: 'continue' }
  | {
      readonly action: 'transform';
      readonly playerMessage?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly reason?: string;
    }
  | {
      readonly action: 'handled';
      readonly events?: readonly PreInputHandledEvent[];
      readonly message?: string;
      readonly reason?: string;
    }
  | {
      readonly action: 'reject';
      readonly status?: number;
      readonly reason: string;
    };
```

处理规则：

- `continue`：进入下一个 hook；
- `transform`：更新 current payload，进入下一个 hook；
- `handled`：停止 hook chain，不调用 `executeTurn`；
- `reject`：停止 hook chain，返回错误。

### 5.3 transform 串联规则

与 pi 一致：多个 transform 可以链式叠加。

例：

1. framework hook 把空白 trim；
2. plugin hook 把 `/roll d20` 转成 `{ actionType: 'trigger_event', topic: 'dice.roll' }`；
3. 后续 hook 看到 transform 后 payload。

### 5.4 handled 结果的 SSE 响应

如果 PreInput handled，不应假装执行了 turn runtime。建议 SSE：

```ts
execution.started { runtimeCount: 0, handledBy: 'pre-input' }
interaction.handled { ... }
execution.completed { runtimeCount: 0, resultCount: 0, handled: true }
```

也可直接 HTTP JSON 返回，但为了保持 action API 统一，建议仍走 SSE。

### 5.5 InteractionRecord 写入

无论 continue / transform / handled / reject，都写 `InteractionRecordRow`：

```ts
{
  source: 'player',
  channel: 'web',
  type: 'message' | 'command' | 'pre-input-handled' | 'pre-input-rejected',
  payload: {
    original: {...},
    final: {...},
    result: 'continue' | 'transform' | 'handled' | 'reject',
    handledBy?: hookId,
    transforms?: [...]
  }
}
```

如果 continue，现有 `message` InteractionRecord 可以扩 meta；避免双写也可以统一只写一次。

### 5.6 典型用例

| 用例 | PreInput 行为 |
|---|---|
| `/roll d20` | 由骰子/规则插件 handled：直接生成 dice event / UI block，不调用 LLM |
| “继续” | 由叙事/引导插件 transform：补全为“继续当前场景，但推进一个明确行动结果” |
| “打开背包” | 由物品插件 handled 或 transform 为 plugin-rpc inventory.open |
| UI 表单提交 | 由表单所属插件 transform：把 payload 标准化为 player.lastFormValues + message cue |
| 敏感/越权输入 | 由安全/审计插件 reject：返回 400/403 + `error.occurred` |
| Debug GM 命令 | 由 dev/admin 插件 handled：仅 dev/admin 可用 |

这些例子只说明插件可以实现的模式，不能落成框架 `if text.startsWith('/roll')` 这类硬编码。

---

## § 6 迁移计划

### P0-a · 类型与 hook runner

- 新增 `PreInputPayload` / `PreInputResult`。
- 新增 `runPreInputHooks()`。
- `HookEvent` 加 `PreInput`，或单独 input-hook registry。
- tests：continue / transform chain / handled first-wins / reject。

### P0-b · 接入 actions route

在 `apps/server/src/routes/api/actions.ts` 中，位于：

1. session 加载之后；
2. `store.addMessage()` 之前；
3. `executeTurn()` 之前。

接入 PreInput。

### P0-c · InteractionRecord 与 SSE

- handled/reject 写入 `InteractionRecord`。
- handled 走统一 SSE envelope。
- trace 增加 `input.transformed` / `input.handled` / `input.rejected`（可选）。

### P0-d · 文档

- `docs/reference/plugins.md`：新增 PreInput hook。
- `docs/reference/protocol.md`：新增 `interaction.handled` 等事件。
- `docs/reference/api.md`：说明 `/api/actions` 的 handled/reject 行为。

---

## § 7 风险 / Tradeoffs

| 风险 | 缓解 |
|---|---|
| 插件滥用 PreInput 抢走所有玩家输入 | 只允许 active/approved plugin；handled first-wins 需要 trace；UI 可显示 handledBy |
| transform 后 message 与原始输入不一致 | InteractionRecord 同时保存 original/final |
| handled 不产生 turn，前端状态机误判 | 明确 SSE `execution.completed { handled: true }` |
| PreInput 写状态绕过 proposal | handler API 不暴露 DataStore 写；需要状态变更走 proposal/plugin-rpc/scoped pluginData |

---

## § 8 是否必须现在做？

是 P0。当前 `actions.ts` 没有输入前置拦截，后续快捷命令、UI block submit、GM/debug 指令、输入安全策略都会各自开旁路。现在补统一入口成本最低。

---

## § 9 待决问题

1. `PreInput` 是否放入通用 HookPipeline，还是单独 input hook runner？倾向单独 runner，复用排序/timeout 代码。
2. handled 是否允许返回 proposals？倾向 P0 不允许，避免绕过 turn pipeline；如需写状态，走 plugin-rpc 或 event。
3. reject 是 SSE `error.occurred` 还是 HTTP 4xx？由于 `/api/actions` 是 SSE，倾向 SSE 内 `error.occurred` + completed。
4. source/channel 如何从 web/desktop/api 区分？需看前端 action client。

---

## § 10 下一步

1. 写 `PreInputPayload` / `PreInputResult` 草案到 runtime hooks types。
2. 在 actions route 加最小 no-op runner，确保行为零变化。
3. 加一个 framework-level test：`/roll d20` handled 不触发 executeTurn。
4. 再开放 plugin manifest 声明。
