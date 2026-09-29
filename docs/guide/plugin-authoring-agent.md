# 插件开发指南 · Agent 与本地代码

Agent 负责语言理解，本地工具负责结构化验证和确定性写入。只需确定性处理时使用 function runtime，避免引入不必要的 LLM 调用。作者字段完整定义见[插件契约参考](../reference/plugins.md)。

## 注册一个工具

根 `PLUGIN.md` 声明注册名、设置和 runtime 工具白名单：

```yaml
---
id: notebook
kind: plugin
description: Saves a brief note after narration.
entry: ./server/index.js
contributes:
  tools: [save-note]
  data:
    notes:
      version: 1
      schema: ./schemas/note.schema.json
runtime:
  type: agent
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        required: true
  agent:
    model: plugin
    tools: { plugin: [save-note] }
    loop:
      maxRetries: 0
      completion: { require: tool-use, afterTools: [save-note] }
---
Read runtime-inputs.narrative.value and call save-note with one supported fact.
```

`server/index.js`：

```js
import makeSaveNote from "../tools/save-note.js";

export default function register(covel) {
  covel.registerTool(makeSaveNote(covel.toolkit));
}
```

`tools/save-note.js`：

```js
import { makeProposal } from "@covel/plugin-handlers-utils";

export default function makeSaveNote({ tool, z, withPendingProposals }) {
  return tool({
    name: "save-note",
    description: "Save a concise fact supported by the current narrative.",
    parameters: z.object({ id: z.string().min(1), text: z.string().min(1) }),
    async execute(params, context) {
      const proposal = makeProposal(
        context,
        new Date().toISOString(),
        "plugin.data",
        {
          namespace: "notes",
          key: params.id,
          value: { id: params.id, text: params.text },
        },
      );
      return withPendingProposals({ saved: true }, [proposal]);
    },
  });
}
```

`schemas/note.schema.json` 应验证 `{id,text}`。工具返回的 proposals 进入当前执行缓冲，提交时统一校验和持久化。不要绕过 proposal 管线直接操作宿主事务，也不要把 sessionId/pluginId 作为用户输入交给存储。

`withPendingProposals(content, proposals)` 始终返回显式对象 `{kind: "covel.tool-result", content, pendingProposals}`，也适用于字符串或冻结的正文。组合工具和测试通过公开 SDK 的 `getToolContent(result)` 读取正文、`getPendingProposals(result)` 读取写入；普通对象展开和 `structuredClone` 会保留两个通道。不要把完整 envelope 当成业务正文。纯读取工具可直接返回正文。

## 读取角色和自有数据

角色通过 `context.world` 的只读 World Model 获取。工具上下文包含上游合法 proposals 和自己的 pending proposals；需要手动物化视图时，使用共享 `materializeWorldModel`，不要重新实现角色字段验证。

Function/RPC 的绑定 store 使用：

```js
const notes = await ctx.store.listPluginData("notes");
const current = await ctx.store.getPluginData("notes", "current");
const characters = ctx.world?.characters ?? [];
```

这里的 namespace 属于当前插件，会话身份由执行上下文绑定。跨插件共享需要公开服务、输入契约或扩展，不能通过额外 pluginId 参数读取对方私有记录。

## RPC 与玩家命令

RPC action 与玩家 slash command 分开声明。一个 action 可以只由 UI 调用而没有 slash command。

```yaml
contributes:
  actions: [inspect-note]
  commands:
    - name: note
      description: Inspect the current note.
      action: inspect-note
```

```js
export default function register(covel) {
  covel.registerRpc("inspect-note", async (_payload, ctx) => {
    const row = await ctx.store.getPluginData("notes", "current");
    return { ok: true, data: row?.value ?? null };
  });
}
```

输入仍需 schema 验证。社区代码的许可由框架管理，不能在 action 中伪造许可或绕过调用路径。涉及写入时遵守相应 SDK 的 proposal 或绑定写入契约。

## 输入契约

```yaml
requires: [narrative-engine@1]
runtime:
  type: function
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1, cardinality: one }
        select: /narrativeOutput
        accepts: ./schemas/narrative.schema.json
        required: true
  function:
    handler: ./handler.js
    timeoutMs: 90000
    tools: { builtin: [get-character] }
```

`handler.js` 默认导出函数。需要调用框架工具时声明 `function.tools`，并经 `ctx.tools.call(name, args)` 调用；工具仍经过 schema、审批和事务管线。使用绑定输入和 `ctx.world` 构建结果，通过 SDK 返回输出与 proposals。想跨 execution 消费结果时，生产者声明 `io.output.recordAs`，消费者声明 `scope: committed` 和相同 `recordAs`。

公开 SDK 同时提供 `PluginFunctionHandler`、`PluginFunctionContext` 和 `PluginAgentGuard`，不需要从私有 loader 导入作者类型。核心上下文包含当前插件的只读 store、缓冲写入、World Model、输入、设置、日志、取消和进度。需要额外宿主能力时，用 handler/guard 的能力参数声明实际依赖；核心接口不承诺每个宿主都提供 provider 或媒体服务。

```js
/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function handler(ctx) {
  const row = await ctx.store.getPluginData("notes", "current");
  return { outcome: "success", value: { found: row !== null } };
}
```

工具先写后读必须读取执行视图，不能重新从 committed store 读取并忽略 pending proposals。上游 proposals 仅参与视图，不能再次加入本 runtime 的提交缓冲。

## 测试

为工具测试使用项目 toolkit 或 `@covel/plugin-test-utils`；在纯函数中隔离规则，测试有效输入、非法输入、无数据和重复调用。返回 proposals 的测试应检查归属、类型和 payload。涉及角色修改时使用实际 CharacterSchema 验证。

可参考 [guide 工具](../../plugins/guide/tools/generate-guide.js)、[world-time RPC](../../plugins/world-time/rpc/time.js) 和各插件 `tests/`。运行对应 workspace 测试后，再执行 `pnpm validate:plugin`。
