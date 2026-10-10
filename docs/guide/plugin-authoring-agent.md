# 插件开发指南 · Agent 与本地代码

Agent 负责语言理解，本地工具负责结构化验证和确定性写入。只需确定性处理时使用 function runtime，避免引入不必要的 LLM 调用。作者字段完整定义见[插件契约参考](../reference/plugins.md)。

## 注册一个工具

根 `PLUGIN.md` 声明注册名、设置和 runtime 工具白名单：

```yaml
---
id: notebook
kind: plugin
description: Saves a brief note after narration.
requires: [narrative-engine@1]
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
    history: { maxTurns: 2 }
    loop:
      maxRetries: 0
      completion: { require: tool-use, afterTools: [save-note] }
---
Read runtime-inputs.narrative.value and call save-note with one supported fact.
```

这个包只有一个 runtime，所以它不用再列一遍工具：没有写 `agent.tools.plugin` 时，runtime 得到 `contributes.tools` 里的全部工具。多 runtime 的包里，每个 runtime 用 `agent.tools.plugin` 列出自己用的工具。

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

agent 只通过 `agent.tools` 里的工具写入。最终 JSON 里的 `statePatches`、`pluginData`、`notifications`、`assetGenerations`、`interactions`、`ui` 和带 `topic` 的事件不会变成 effects：内核把它们去掉，并在服务端日志里写下 runtime 和字段名。需要写数据就给 agent 一个工具（上面的 `save-note`、内置的 `plugin-data-set`、`emit-event`、`create-notification`）并列进 `agent.tools`；`preGameDone` / `completion` 仍用来报告完成。

一个 `plugin.data` 值序列化成 JSON 后最多 256 KiB（见[数据归属](plugin-authoring.md#数据归属)）。

`withPendingProposals(content, proposals)` 始终返回显式对象 `{kind: "covel.tool-result", content, pendingProposals}`，也适用于字符串或冻结的正文。组合工具和测试通过公开 SDK 的 `getToolContent(result)` 读取正文、`getPendingProposals(result)` 读取写入；普通对象展开和 `structuredClone` 会保留两个通道。不要把完整 envelope 当成业务正文。纯读取工具可直接返回正文。

## 控制历史窗口

不声明 `agent.history` 时，agent 看到会话共享的历史视图：未压缩的消息加压缩摘要，长度随会话增长，直到触发压缩。只处理本轮输入的提取类 runtime 应声明窗口：

```yaml
agent:
  history: { maxTurns: 2 } # 0 表示不带历史
```

`maxTurns` 按 `turnId` 计数，保留最近 N 个回合的可见消息，不再附带压缩摘要，也不参与本轮压缩屏障。当前玩家输入、本回合正文、`<runtime-inputs>`、selfData 与扩展段不受影响。需要长期回顾的 runtime 改用自有 plugin-data，或在 function runtime 中用 `ctx.store.readTurnMessages()` 分页读取完整原始记录。

叙事之后运行的 agent（`post-turn` / `audit`）读到的对话以本回合的故事正文结尾：它以 assistant 消息接在当前玩家输入之后，再跟一条框架提示。正文里说「对话里最后一段故事正文是本回合的叙事」即可让模型从正文结尾的局面出发；需要结构化取值或来源信息时仍读 `runtime-inputs.<binding>.value`；整个值就是本回合正文的绑定在那里只留一句指向对话的话，正文不发第二遍。细节见 [Prompt 结构](../reference/prompt-structure.md#本回合正文)。

正文里取值随剧情变化的模板变量（`{{ player.character }}`、`{{ characters.npcs }}`）会让 system prompt 每回合不同，服务商的前缀缓存就够不到历史。把这类内容改为回合级提示段的做法见 [Template 变量与数据边界](../reference/prompt-structure.md#4-template-变量与数据边界)。

Function runtime 没有组装好的对话。`ctx.store.listTurnMessages()` / `readTurnMessages()` 只返回已提交的消息，不含正在执行的这一回合；本回合的内容从 `ctx.playerMessage`、`io.inputs` 绑定（如 `narrative-engine@1`）或内核输入 `turn-digest@1`（含 `playerMessage` 与 `narrativeText`）读取。

## 读取角色和自有数据

角色通过 `context.world` 的只读 World Model 获取。工具上下文包含上游合法 proposals 和自己的 pending proposals；需要手动物化视图时，使用共享 `materializeWorldModel`，不要重新实现角色字段验证。

Function/RPC 的绑定 store 使用：

```js
const notes = await ctx.store.listPluginData("notes");
const current = await ctx.store.getPluginData("notes", "current");
const characters = ctx.world?.characters ?? [];
```

`ctx.store.getPluginData` 返回 `{ key, value }` 或 `null`，`listPluginData` 返回这样的行。`ctx.pluginData`（function runtime 里读写，guard 和扩展 handler 里同样的读法）在每种上下文里用同一种读法：`get(namespace, key)` 返回存下的值本身，没有时返回 `null`；`list(namespace)` 返回 `{ key, value, createdAt, updatedAt }`。

这里的 namespace 属于当前插件，会话身份由执行上下文绑定。跨插件共享需要公开服务、输入契约或扩展，不能通过额外 pluginId 参数读取对方私有记录。

需要回看完整故事记录时，按游标分页读取已提交的时间线，包括已被压缩摘要替代的原文：

```js
const saved = await ctx.store.getPluginData("progress", "cursor");
let after = saved?.value ?? undefined;
let page;
do {
  page = await ctx.store.readTurnMessages({ after, limit: 200 });
  for (const message of page.messages) collect(message); // {turnId, role, content, compacted, ...}
  after = page.cursor ?? undefined;
} while (page.hasMore);
await ctx.pluginData.set("progress", "cursor", after ?? null);
```

`limit` 默认 100、最大 500。`cursor` 是不透明字符串，指向最后读到的消息（空页时原样返回 `after`），`hasMore` 为 `false` 表示已读到当前末尾。把游标存进自己的 plugin-data，下次执行只读新增部分。

## 表单

要向玩家要结构化输入（建角色、配点），agent 调用内置 `create-form`，function runtime 在 `effects.interactions` 里返回同样形状的 `{ type: "form", interactionId, title, fields, submitLabel }`（SDK 类型 `PluginFormInteraction`）。可选的 `notice` 是字段上方的一行说明，用来告诉玩家为什么又看到这张表单（例如上一次提交没法用），写成会话语言。

表单自带的检查（必填、范围、选项）之外，业务规则放在校验器里：根 `PLUGIN.md` 的 `contributes.forms` 声明名字，表单的 `validation: { name }` 引用它，entry 用 `covel.registerFormValidator` 注册：

```js
covel.registerFormValidator("point-buy", (values, data, context) => {
  const issues = [];
  if (Number(values.strength) > 15) {
    issues.push({
      field: "strength",
      message: translate(context, "Strength is at most 15."),
    });
  }
  return issues.length > 0 ? issues : undefined;
});
```

校验器是同步纯函数，第三个参数是会话语言和本插件在该语言下的翻译。返回字符串是整张表单的错误；返回 `{ field, message }` 或它们的数组（`PluginFormIssue`）时，玩家在对应字段下面看到每一条，所有出错的字段一次全部列出。被拒绝的提交在响应流里是一个 `code: "form_rejected"` 的 `error.occurred`，不写入任何内容，也不开始回合，玩家填的值保留。

玩家的回答通过 `POST /api/actions` 的 `submit_interaction` 提交：同一个请求保存回答并运行读取它的回合。同一张表单（同一个 `turnId` 和 `interactionId`）只能回答一次，再次提交得到 `code: "interaction_already_submitted"`。别的标签页或设备重新载入时，`GET /api/sessions/:id/view` 的 `submittedInteractions` 把已回答的表单标为已回答。契约见 [tools.md](../reference/tools.md) 和 [api.md](../reference/api.md)。

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

需要有限历史又需长期背景时，可声明 `agent.history: { maxTurns: 2, includeSummaries: true }`。默认的有限窗口不带摘要；该 runtime 不触发共享压缩。
