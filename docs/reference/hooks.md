# Hook

Hook 是一段插件代码。内核在固定的时刻调用它：会话开始或结束、回合开始或结束、某个 runtime 运行前后、每次模型调用前后、每次工具调用前后、每条写入提交前后。本页列出全部 18 个事件，以及每个事件给 handler 什么、handler 可以返回什么。写 Hook 的插件作者需要它。

一个 Hook 只做三件事之一：

- **拦截**：阻止这次操作。
- **改写**：改变这次操作收到的内容或返回的结果。
- **旁观**：只看，不改，用来记录和清理。

Hook 不写玩法。一条玩法规则应该放在 runtime 或工具里。

> [!NOTE]
> 事件名只在一处定义：`HOOK_EVENTS`（`packages/shared/src/types/hooks.ts`）。每个事件怎么运行写在 `HOOK_SEMANTICS` 和 `GUARD_HOOK_EVENTS`（`packages/runtime/src/hooks/types.ts`），负载在 `packages/runtime/src/hooks/wire-helpers.ts` 里构造。本页和这些表对不上时，`packages/runtime/tests/hooks-reference-doc.test.ts` 会失败。

## Declaring and registering

分两步：根 `PLUGIN.md` 列出要用的事件，`entry` 模块（默认 `server/index.js`）注册 handler。两边必须一致，否则插件加载失败。一条声明可以对应多个 handler，每个 handler 调用一次 `covel.on()`。

```yaml
contributes:
  hooks: [PreToolUse]
```

```js
export default function (covel) {
  covel.on("PreToolUse", async (ctx, payload) => {
    if (ctx.runtimeId !== "my-plugin/tracker") return { action: "continue" };
    if (payload.toolCall.name !== "delete-note") return { action: "continue" };
    return { action: "abort", reason: "This runtime may not delete notes." };
  });
}
```

`covel.on(event, handler, options?)` 的 `options` 有三项：

| 选项        | 含义                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `match`     | `(payload) => boolean`。返回 `true` 时 handler 才运行。它拿到的是负载的一份独立副本。                   |
| `timeoutMs` | handler 一次调用的时间上限，默认 5000 毫秒。                                                            |
| `enforce`   | 排序分组：`pre`、`normal`（默认）或 `post`。必须和 `contributes.hooks` 里声明的分组相同。顺序规则见下。 |

`contributes.hooks` 的一项可以只写事件名，也可以写成对象 `{ event, enforce?, holdsDrafts? }`：`enforce` 写 `normal` 以外的分组；`holdsDrafts` 只用于 `ReviewAgentOutput`，见[压住故事草稿](#holds-drafts)。`holdsDrafts` 只写在声明里，`covel.on()` 没有对应的选项。

同一个事件的 handler 按分组依次运行：`pre` → `normal` → `post`。同一组内，框架自己的 Hook 先运行，然后是插件的 handler，按注册顺序。两个插件之间谁先谁后不是可以依赖的约定。

Hook 什么时候会运行：

- 插件在这个会话里处于启用状态。
- 社区插件还需要玩家在这个会话里批准过它的服务端代码。没有批准时 handler 被跳过。

## The handler

```ts
type Handler = (ctx: PluginHookContext, payload: Payload) => Promise<Result>;
```

handler 收到两个参数：上下文 `ctx` 和负载 `payload`。它返回一个结果，告诉内核继续、改写还是中止。

### Context

所有事件的所有 handler 收到同一种形状的上下文。

| 字段              | 值                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`           | 事件名。                                                                                                                                                                                                          |
| `sessionId`       | 会话。                                                                                                                                                                                                            |
| `turnId`          | 事件所属的那次执行。`SessionStart` 和 `SessionEnd` 时是空字符串。                                                                                                                                                 |
| `locale`          | 会话的内容语言，创建会话时就定下。Hook 自己添加文字时用它：`instructionLocaleFor(ctx.locale)` 给出提示词正文的语言（`en` 或 `zh`）。                                                                              |
| `pluginId`        | 事件说的是哪个 runtime，这里就是那个 runtime 所属的插件。它不是注册 handler 的插件。下表里范围为 `runtime` 的事件才有这个字段，其余事件没有。                                                                     |
| `runtimeId`       | 事件说的是哪个 runtime，例如 `world-init/dimension-tracker`。和 `pluginId` 同时出现、同时缺席。两个提交事件里，它是产生那条 proposal 的 runtime。                                                                 |
| `activePluginIds` | 会话里启用的插件。                                                                                                                                                                                                |
| `getOwnSettings`  | 返回 handler 所属插件解析后的设置（清单默认值、世界预设、玩家填的值），只读。写法：`ctx.getOwnSettings?.() ?? {}`。                                                                                               |
| `signal`          | 一个 `AbortSignal`。这次执行被取消，或 handler 超过时间上限时，它会触发。把它传给任何可能等待的调用。`SessionStart`、`SessionEnd`、`PostStateCommit` 和 `TurnStop` 不随执行取消，它们的 `signal` 只在超时时触发。 |

runtime 的身份只在上下文里。负载不会重复 `pluginId` 或 `runtimeId`，所以一句 `ctx.runtimeId === "..."` 对每个事件都适用。

### Payload

负载是一份私有副本。直接修改它没有任何效果。要改内容，把改动放在返回值的 `replace` 里。

### Result

| 返回值                                   | 效果                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `{ action: "continue" }`，或不返回值     | 什么都不变。                                                                                            |
| `{ action: "continue", replace: {...} }` | 改写。`replace` 按字段覆盖到负载上，下一个 handler 收到合并后的负载。每个事件只认它自己列出的那些字段。 |
| `{ action: "abort", reason }`            | 拦截。在可以拦截的事件上，操作被阻止，`reason` 会被报告出来。在其他事件上，它等于“什么都不变”。         |

## How an event runs

下面的事件表用两个英文词说明 handler 怎么运行：

- **sequential**（依次）：handler 一个接一个按顺序运行。前一个的 `replace` 会传给下一个。一个 `abort` 结束整条链。
- **parallel**（同时）：handler 同时运行。事情已经发生了，所以返回值改变不了任何东西。这类事件用来记录和清理。

表里的 Guard 列写 `yes` 的事件是“可以拦截的事件”。

handler 抛出异常、超时或返回了格式不对的结果，都算这个 handler 失败。失败之后怎么办，取决于事件：

- **可以拦截的事件**：失败按 `abort` 处理。一条坏掉的规则不能让它本该拦住的操作通过。
- **其他事件**：跳过这个 handler，它之前的 handler 做出的改写保留，失败记入 trace（`hook.error`）。

抛错、超时或返回无效结果，会计入注册这个 Hook 的插件的[故障熔断](./protocol.md#插件故障熔断)。主动返回 `abort` / 否决不算 Hook 故障；`PreStateCommit` 的主动否决属于 proposal 所属插件的拒绝。父执行取消不算 Hook 故障。

## Events

“范围”一列说明事件是关于什么的：`session`（整个会话）、`turn`（一次执行）、`runtime`（一个 runtime）。范围为 `runtime` 的事件里，`ctx.pluginId` 和 `ctx.runtimeId` 就是那个 runtime。

表按 `HOOK_EVENTS` 的顺序列出。工具事件在 agent 循环里反复触发；它们并不发生在 `PostRuntime` 之后。

| 事件                  | 范围    | 运行方式   | Guard | handler 可以做什么                                     |
| --------------------- | ------- | ---------- | ----- | ------------------------------------------------------ |
| `SessionStart`        | session | parallel   | no    | 旁观                                                   |
| `TurnStart`           | turn    | sequential | yes   | 中止这个回合                                           |
| `PreCompaction`       | turn    | sequential | yes   | 中止这个回合的历史压缩                                 |
| `PostCompaction`      | turn    | parallel   | no    | 旁观                                                   |
| `PreSchedule`         | turn    | sequential | no    | 去掉或重排这个回合选中的 runtime                       |
| `PreRuntime`          | runtime | sequential | yes   | 中止这个 runtime（记为 skipped）                       |
| `PostContextAssembly` | runtime | sequential | no    | 改写系统提示词和历史                                   |
| `PreStep`             | runtime | sequential | no    | 收窄这一步的工具、改工具选择、减少剩余步数，或结束循环 |
| `PreLLMCall`          | runtime | sequential | no    | 改写一次调用的消息、模型和工具                         |
| `PostLLMResponse`     | runtime | sequential | no    | 改写回答，或要求模型改正                               |
| `ReviewAgentOutput`   | runtime | sequential | yes   | 接受校验后的输出，或要求重新提交                       |
| `PostRuntime`         | runtime | sequential | no    | 改写 runtime 的结果                                    |
| `PreToolUse`          | runtime | sequential | yes   | 中止工具调用，或改写它的名字、参数                     |
| `PostToolUse`         | runtime | sequential | no    | 改写工具结果，或结束工具循环                           |
| `PreStateCommit`      | runtime | sequential | yes   | 中止一条 proposal，或改写它的 payload                  |
| `PostStateCommit`     | runtime | parallel   | no    | 旁观                                                   |
| `TurnStop`            | turn    | parallel   | no    | 旁观                                                   |
| `SessionEnd`          | session | parallel   | no    | 旁观                                                   |

下面每个事件一节，依次写：什么时候触发、负载里有什么、返回值有什么效果。

### `SessionStart`

新会话和它导入的世界数据存好之后触发，只有一次。这时会话已经存在，handler 不能阻止它被创建。

负载：`{ sessionId, worldId? }`。

### `TurnStart`

每次执行开始时触发，在选出任何 runtime 之前。玩家回合、手动运行、后台任务都算一次执行。

负载：`{ playerMessage, actions, activeRuntimes }`。`playerMessage` 是内核从玩家行动渲染出的文字；`actions` 是解析后的行动（每个是 `{ seatId, kind, actorId?, text?, fields?, interaction?, source }`），没有玩家输入的执行是空数组；`activeRuntimes` 是这个会话的 runtime ID 列表。

`abort` 结束这次执行，不运行任何 runtime。`reason` 作为这个回合的中止原因返回给客户端。

### `PreCompaction`

历史压缩之前触发，只在需要压缩的回合。

负载：`{ messageCount }`，即可以被压缩的已存消息条数。

`abort` 让这个回合的历史保持原样。

### `PostCompaction`

一次压缩尝试之后触发。被 `PreCompaction` 拦下的压缩不触发它。

负载：`{ compacted, summaryId? }`。

### `PreSchedule`

选出要运行的 runtime 之后、排定顺序之前触发。

负载：`{ triggered }`，即这次执行选中的 runtime 的清单。

`replace.triggered` 可以缩小或重排这个集合：

- 条目按 `name` 和选中的 runtime 对应。没被选中的条目会被丢掉。
- 内核始终使用自己的清单对象，所以 handler 加不了 runtime，也改不了清单。
- `replace: { triggered: [] }` 表示什么都不调度。
- `abort` 等于“什么都不变”。

### `PreRuntime`

一个 runtime 开始前触发一次，在它的 guard、agent 循环或函数 handler 之前。每个逻辑 runtime 只触发一次：从挂起中恢复的运行不再触发，不论它挂起过几次。想拦下 agent 的挂起，对 `suspend` 工具用 `PreToolUse`。

负载：`{ manifest, input }`，即这个 runtime 的清单和回合输入。

`abort` 跳过这个 runtime：它的结果状态是 `skipped`，带上原因。这个事件不读 `replace`。

### `PostContextAssembly`

对 agent runtime 触发一次：它的上下文组装好之后、第一次模型调用之前。从挂起中恢复的运行不再组装上下文，也不再触发它：保存下来的对话记录已经带着这次处理的结果。

负载：`{ systemPrompt, messages, outputKind?, promptTemplate?, inputSlots?, characters?, currentCharacterId?, promptSegments? }`。

| 字段                 | 内容                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputKind`         | `story` 或 `system`。                                                                                                                                                                                           |
| `promptTemplate`     | 这个 runtime 的提示词正文，渲染之前的样子。                                                                                                                                                                     |
| `inputSlots`         | 解析后的 `io.inputs` 值。                                                                                                                                                                                       |
| `characters`         | 会话里的角色（`id`、`name`、`type`、`description`）。                                                                                                                                                           |
| `currentCharacterId` | 玩家当前扮演的角色的 `id`：主座位的当前角色（见[座位](./world-model.md#座位)），是 `characters` 中的一个。没有座位绑定角色时不出现。按它找玩家角色，不要按 `type === "player"` 找：一个会话可以有多个玩家角色。 |
| `promptSegments`     | 这个 runtime 的提示词用到的 [`prompt.segment@1`](./extension-points.md) 片段，每条是 `{ pluginId, id }`：提供片段的插件，以及它给片段起的 `id`。`audience` 没有包含这个 runtime 的片段不列出。                  |

想知道自己的插件往提示词里放了什么，读 `promptSegments`，不要去搜提示词文本。Hook 需要区分几种状态时，给每种状态的片段起不同的 `id`。内置的 `world-init` 是例子：规则全部放得下时，它的规则片段叫 `dimension-rules`；有规则被截掉时叫 `dimension-rules-truncated`。它的 `PreLLMCall` handler 只在第二种情况下才提供读取工具。

`replace.systemPrompt` 和 `replace.messages` 有效。框架自己写在系统提示词开头的内容（runtime 框架说明、输出语言指令、完成约定）会被重新放到替换后的系统提示词前面，handler 不用自己带上它们。

### `PreStep`

agent runtime 的工具循环每走一步、调用模型之前触发一次：在玩家插话并入对话之后，在 `PreLLMCall` 之前。步数用完之后的收尾步骤（见 [结束原因](./protocol.md#stop-reasons)）不触发它。从挂起中恢复的运行和普通运行一样，每一步都触发。

负载：`{ step, stepsRemaining, maxSteps, toolNames, toolChoice }`。

| 字段             | 内容                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `step`           | 这是第几步，从 1 开始。                                          |
| `stepsRemaining` | 包括这一步在内还剩几步。                                         |
| `maxSteps`       | 当前的步数上限。                                                 |
| `toolNames`      | 这一步提供给模型的工具名。                                       |
| `toolChoice`     | 循环本来要发出的工具选择：`"auto"`、`"required"` 或 `{ name }`。 |

`replace` 认这四个字段，不合法的部分被丢掉，不会让 runtime 失败：

- `replace.tools`：只给模型这些工具。它只能是 `toolNames` 的子集，不在里面的名字被忽略，并记进这一步的 `step.completed`。收窄只管这一步，下一步又从完整的工具集开始。它也不改变哪些工具可以执行：模型调用了被去掉的工具，只要清单声明了它，仍然会执行。
- `replace.toolChoice`：这一步的工具选择，替换清单的 `agent.toolChoice`。`"auto"` 表示不指定；`{ name }` 必须是这一步提供的工具。runtime 要求模型改正、必须调用工具的那一步，`"auto"` 不会取消这个要求。
- `replace.stepsRemaining`：把剩余步数减到这个整数（至少 1，包括这一步）。比当前值大的数被忽略，步数只能减少。用完后循环以 `max-steps` 结束。
- `replace.stop: { reason, message? }`：在这一步调用模型之前结束循环。`reason` 只能是这两个：
  - `"tool-finished"`：请求结束循环；没有已接受的提交时，以 `invalid-output` 失败。
  - `"cancelled"`：runtime 失败，错误是 `Runtime "<id>" was stopped by a PreStep hook`，后面跟 `message`。已经做过的工具调用留在失败的结果里。

`abort` 等于“什么都不变”。`PreStep` 先运行，`PreLLMCall` 再改写这次调用：`PreLLMCall` 的 `replace.tools` 会覆盖 `PreStep` 收窄后的工具。

### `PreLLMCall`

agent runtime 的每次模型调用之前触发，包括工具结果之后的调用和收尾步骤。同一步里，`PreStep` 先运行。

负载：`{ messages, model, tools, stream?, promptSegments? }`。`promptSegments` 和 `PostContextAssembly` 里的是同一份列表。从挂起中恢复的运行带着挂起前保存的同一份列表。

- `replace.messages`、`replace.model`、`replace.tools` 只改这一次调用，runtime 自己的对话记录不变。
- 收尾和循环回退请求在 Hook 后仍只提供 `submit-output`；不能恢复业务工具。
- `replace.stream: false` 让这次调用不走流式。
- `abort` 等于“什么都不变”。

### `PostLLMResponse`

每次模型回答之后触发，在执行回答里的工具调用之前。

负载：`{ response, messages }`，即回答，以及实际发出去的消息。

最终输出在 `ReviewAgentOutput` 中审查；这里的 `response` 始终是一次真实供应商响应，可能只有工具调用。

- `replace.response` 改写待处理回答，不能创造调用或更改供应商的原调用 ID、推理和 continuation。
- `replace.correction`（非空字符串）退回这份草稿：其中的工具调用不执行，每个原调用 ID 都收到相关联的错误；原始 assistant 消息和 continuation 保留，模型在下一普通步骤重新提交。每次退回消耗一次 `agent.loop.corrections.review` 预算，默认允许纠正两次；预算用尽后再次退回，runtime 以 `invalid-output` 失败。配置见[循环 profile](./plugins.md#循环-profileagentloopprofile)。

### `ReviewAgentOutput`

`submit-output` 的完整对象通过 schema、故事不变量和必需工作检查后触发。负载类型由 SDK 导出为 `ReviewAgentOutputPayload`：`{ output, toolCall: { id, name }, toolResults, correction? }`。`toolCall` 保留供应商最初的身份；`toolResults` 只有本 runtime 已完成调用（不含提交工具）的公开 `toolCallId`、`toolName` 和 `output`，不含隐藏提交元数据或私有子 agent 值。

返回 `continue` 接受；`replace.correction` 要求修正，最多保留 2000 字符，与 `PostLLMResponse` 共用审查预算。一个 reviewer 的纠正不能被后续 reviewer 清除。其他替换字段无效，不能修改候选值、工具证据、effects 或 completion。直接修改负载也无效。抛错、超时或无效结果按 guard 失败关闭，不作为模型可纠正错误；`abort` 终止本次运行。`ctx.pluginId` / `runtimeId` 仍指被审查的 runtime，`getOwnSettings()` 仍读取 handler 所属插件设置。

<a id="holds-drafts"></a>

#### 压住故事草稿

故事 agent 写 `submit-output` 时，玩家默认在提交前就能读到[草稿](./plugins.md#story-drafts)。草稿没有经过审核：一次被你打回的提交，玩家可能已经读过。对多数审核这没有关系。检查格式、长度或者有没有写说话人的审核，被打回的版本闪过一下也无妨。

有的审核存在的意义，就是不让玩家读到某些文字。这样的审核声明 `holdsDrafts: true`：

```yaml
contributes:
  hooks:
    - { event: ReviewAgentOutput, holdsDrafts: true }
```

两个例子：

- **防剧透**：悬疑世界里，审核检查叙事有没有提前说出凶手。没有 `holdsDrafts` 时，“管家袖口有血迹，他就是凶手”会先作为草稿显示，审核打回后才撤回，玩家已经读到了。声明后，被打回的这一版玩家看不到。
- **内容分级**：全年龄插件拦下过激的描写。被拦下的段落哪怕只闪一下，也已经给玩家看到了。

为什么由审核插件声明：叙事插件和审核插件常常出自不同作者，由玩家组合在一起用。叙事作者不知道谁会审它，不能替审核写 `io.output.live: off`；玩家也不知道哪个世界该选“回合保存后”。只有审核插件自己知道，它审的内容不能提前给人看。

声明之后：

- 会话启用了这个插件时，这个会话的故事 runtime 都不再逐段显示草稿。审核按 `ctx.runtimeId` 决定审哪个 runtime，内核没法提前知道，所以按会话生效。
- 每次提交通过全部审核后，故事一次显示出来。它仍然不用等后面的插件运行和回合提交，比提交后才显示要早。
- 插件在会话里停用，或者因故障被熔断后，声明不再生效。
- 声明只让草稿更保守，不授予任何权限，也不进插件的能力清单，改动它不需要玩家重新批准。
- 只能写在 `ReviewAgentOutput` 上，写在其他事件上会被拒绝。`pnpm plugin:extract` 同步声明时保留它。

只查格式或质量的审核不要声明，否则玩家就读不到逐段显示的故事了。

### `PostRuntime`

一个 runtime 结束后触发一次，不论它以成功、失败还是跳过结束。runtime 挂起时不触发；它恢复后真正结束时触发，每个逻辑 runtime 只触发一次。

负载：`{ result, resumed? }`。`result` 是 `RuntimeResult`。结束的是从挂起中恢复的运行时，`resumed` 为 `true`；否则没有这个字段。

agent 只有已经接受 `submit-output` 才能成功；Hook 不能把未提交、失败或跳过的 agent 恢复为成功。函数的恢复规则保持不变。

`replace.result` 替换结果。内核对替换后的结果做这几件事：

- 保留原结果的 `pluginId`、`runtimeId`、`runId`、`turnId`。
- 写入只来自 runtime 自己：`pendingProposals`、`effects` 和 `completion` 一律取原结果的值，Hook 加的会被丢掉。要拦下一条写入，用 `PreStateCommit`。
- Hook 改了 `status` 时（比如把失败改成成功），这次运行的 `pendingProposals`、`effects` 和 `completion` 全部丢弃。失败的函数 handler 在失败前攒下的写入也不提交。setup runtime 被 Hook 从失败改成成功，也不记为完成，仍是待完成。
- handler 改了 `output` 却没动 `canonicalValue` 时，内核丢掉旧的 `canonicalValue`。这样其他 runtime 读到的值不会和改写后的输出对不上。
- 再按 runtime 的 `output.schema` 检查一遍：函数 runtime 检查 `canonicalValue`，agent 在 Hook 改了 `output` 时检查 `output`。函数从失败或跳过改成成功的结果没有 `canonicalValue`，检查的是 `output`，和正常成功走同样的检查。不符合时 runtime 以 `output-schema-invalid` 失败，什么都不提交。

### `PreToolUse`

agent runtime 的每次工具调用之前触发，函数 runtime 经 `ctx.tools.call` 的每次调用之前也触发。

负载：`{ toolCall: { id, name, arguments } }`，`arguments` 是 JSON 字符串。

- `abort` 跳过这次调用，`reason` 作为工具的 `refused` 错误回给模型。agent 循环还记录 `tool.calling` / `tool.failed`，带 `skipped: true` 和 `skipReason: "hook-aborted"`；不计入已执行调用或失败计数。
- `replace.toolCall` 可以改 `name` 或 `arguments`，`id` 保持不变。

整批 `PreToolUse` 在任何业务工具派发前按模型顺序各运行一次。内核检查原始及最终名字，拒绝混合提交批次，再按原有只读池/屏障规则运行普通工具。assistant 历史保留原始调用；执行和授权使用改写后的名字与参数。

### `PostToolUse`

每次实际执行过的工具调用之后触发。并行池的所有成员先全部结束，再按模型顺序运行各自的 `PostToolUse`；屏障的 Hook 在这次单独调用结束后运行。

负载：`{ toolCall, result }`。

`result.result` 是统一工具结果的 JSON 文本。失败时 `result.error` 是 `{code,message,hint?}`；它和副作用、`success`、`refused`、审批状态一样不可被替换。Hook 可以改写模型文本或 `parsedResult`，不能改变失败计数和结构化错误。

- `replace.result` 替换模型读到的结果（函数 runtime 里是 `ctx.tools.call` 返回的值）。工具交出的写入和事件、是否成功、审批状态都保持原样。
- `replace.terminate: true` 在当前步骤结束后结束工具循环。并行池中所有已经启动的成员都正常记下结果并运行 `PostToolUse`，任一成员要求结束都跳过后面的步骤；屏障要求结束时跳过所有后续调用。跳过的调用以 `cancelled` 工具结果关闭，并记录带 `skipReason: "terminated"` 的 trace。

### `PreStateCommit`

一次执行的每条 proposal 在提交之前各触发一次。`ctx.pluginId` 和 `ctx.runtimeId` 是这条 proposal 的来源。

负载：`{ proposal }`。

- `abort` 拒绝这条 proposal，带上原因。
- `replace.proposal.payload` 替换 payload。proposal 的类型、来源和 ID 保持不变。

[写服务](./plugin-extensions.md#写服务)暂存的写入以提供者为来源到达：`ctx.pluginId` 是提供者，`ctx.runtimeId` 是 `service:<服务名>`，发起调用的插件不出现在 Hook 里。拒绝其中任何一条，整个操作被拒（见[事务 · 写服务的操作](./transactions.md#写服务的操作)）。

读取基线条件由内核独立持有，不进入交给 Hook 的 payload 对象，也不能被删除或替换。Hook 不能重定向已保护的目标或 batch 成员；同目标改写保留检查，新加入的替换也会获得适用的已记录基线。见[事务](./transactions.md#read-baselines)。

### `PostStateCommit`

一条 proposal 提交之后触发。要在数据真正写入之后做事，用这个事件。

负载：`{ proposal, result }`。

### `TurnStop`

一次执行运行完它的全部 runtime 时触发。这时写入还没有提交，之后仍可能在提交时被拒绝。

负载：`{ runtimeResults, durationMs }`。

### `SessionEnd`

会话被结束或被删除时触发。

负载：`{ sessionId, reason }`，`reason` 是 `ended` 或 `deleted`。

## Limits

- Hook 没有自己的写入途径。插件的数据由它的 runtime 和工具写入。Hook 的返回值能改写结果和 proposal 的 payload，但加不了新的写入。
- handler 不能依赖其他插件 handler 的先后顺序，自己的 `enforce` 分组除外。
- 声明了 `io.concealed` 的 runtime，提示词和回答不会出现在 trace 和实时流里。但已启用插件的 Hook 仍然会在负载里收到它们。社区插件的 Hook 只有在玩家批准了它的服务端代码之后才运行。

- 因故障暂停的插件从下次执行起不运行 Hook；当前执行保留冻结的启用集合。

前台回合 Hook 的可选 `logicalTurn` 是根输入冻结的逻辑回合号。setup、开场和同一输入的自动推进共享它；生命周期事件没有执行上下文时可省略。
