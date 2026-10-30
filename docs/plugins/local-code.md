# 带本地代码的插件

这一页带你给插件加上自己的代码：一个模型可以调用的工具、一个界面和玩家命令可以调用的动作、一个不经过模型的函数。做完之后，你有一个插件“notebook”：每回合故事之后，模型调用你写的 `save-note` 工具记下一条事实。

分工的原则是：**模型负责读懂文字，代码负责检查和写入。**如果一件事完全可以用规则算出来，就不要用模型，直接写函数。

## 开始之前

- 做完了[第一个插件](./first-plugin.md)，读过[写插件要知道的规则](./essentials.md)。
- 会写一点 JavaScript。
- 下面的命令都在 Covel 仓库的根目录运行。

> [!IMPORTANT]
> 这一页的插件放在用户插件目录里。Covel 提供 `@covel/plugin-handlers-utils` 和 `zod`，代码可以直接导入；安装插件时不会执行 `npm install`。其他依赖需要打包进插件。

## 1. 建文件夹

```bash
mkdir -p ~/.covel/plugins/notebook/{server,tools,schemas,tests}
```

做完第 5 步，文件夹里是这些文件：

```text
notebook/
├── PLUGIN.md                  配置和提示词
├── README.md
├── server/
│   └── index.js               入口文件：注册工具和动作
├── tools/
│   └── save-note.js           工具
├── schemas/
│   └── note.schema.json       一条记录应该长什么样
└── tests/
    └── runtime-cases.json     离线运行的用例
```

不需要 `package.json`：Covel 把插件里的 `.js` 文件当作 ES module 加载，版本写在 `PLUGIN.md` 里。

## 2. 写 `PLUGIN.md`

```yaml
---
version: 0.1.0
description: Saves a brief note after narration.
requires: [narrative-engine@2]
contributes:
  tools: [save-note]
  data:
    notes:
      schema: ./schemas/note.schema.json
runtime:
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@2 }
        select: /narrativeOutput
  agent:
    history: { maxTurns: 2 }
    finishWith: save-note
---
Read `runtime-inputs.narrative.value`. Call `save-note` one time with one fact that the narrative states.
```

和只有提示词的插件相比，多了这几处：

| 这一段                           | 意思                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `version`                        | 插件的版本。有入口文件的插件要写，每次发布时调高；没写时 `pnpm validate:plugin` 会提醒 |
| `server/index.js`                | 入口文件。Covel 加载插件时运行它，由它注册工具。放在这里就不用写 `entry`               |
| `contributes.tools`              | 这个插件注册了哪些工具。必须和入口文件里注册的名字一致                                 |
| `contributes.data.notes`         | 声明 `notes` 这个数据空间，以及一条记录的形状（schema）                                |
| `agent.history: { maxTurns: 2 }` | 只给模型看最近 2 个回合的对话。见[控制模型看到多少历史](#控制模型看到多少历史)         |
| `agent.finishWith`               | `save-note` 成功之后，这个 agent 立刻结束，不再多问模型一次                            |

这个插件只有一个 runtime，所以不用写 `agent.tools.plugin`：它自动得到 `contributes.tools` 里的全部工具。

## 3. 写工具

`tools/save-note.js`：

```js
import { makeProposal } from "@covel/plugin-handlers-utils";

export default function makeSaveNote({
  tool,
  z,
  withPendingProposals,
  withModelView,
}) {
  return tool({
    name: "save-note",
    description: "Save one short fact that the current narrative states.",
    annotations: { idempotent: true },
    parameters: z.object({
      id: z.string().min(1).describe("Stable short key, e.g. gate-is-locked"),
      text: z.string().min(1).max(300),
    }),
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
      return withModelView(
        withPendingProposals({ id: params.id }, [proposal]),
        { summary: "Queued a note." },
      );
    },
  });
}
```

这个文件导出一个函数。Covel 把一组帮手传给它：

| 帮手                   | 作用                                                |
| ---------------------- | --------------------------------------------------- |
| `tool`                 | 定义一个工具                                        |
| `z`                    | 描述参数的形状（Zod）。模型传错参数时，调用会被拒绝 |
| `withPendingProposals` | 把“工具返回给模型的内容”和“想写入的数据”一起交回去  |
| `withModelView`        | 选择模型读取的摘要和数据，不改变代码读取的正文      |
| `ToolError`            | 抛出带错误码和可选提示的失败                        |
| `shortId`              | 生成短 ID。第四个参数传 `context.random`            |

模型读取[统一工具结果](../reference/tools.md#统一返回格式与错误码)。这个例子只发送摘要和自动附加的暂存提示；代码仍读取 `{id}`。需要报告可修正的失败时，可抛出 `new ToolError("not-found", "The requested note was not found.", { hint: "Check the name." })`。`ctx.tools.call` 成功时返回完整正文，失败时抛出 `ToolError`；message 是纯文本，code 和 hint 是独立字段。

工具不直接写存档。它返回一条**写入请求**（proposal）：类型是 `plugin.data`，内容是“往 `notes` 里写这一条”。Covel 在执行提交时检查这些请求。这个 runtime 失败或提交被拒时，不会保存这份写入。

这个工具按稳定 key 覆盖同一条记录，所以声明 `idempotent: true`。只读工具还可以声明 `readOnly`、`concurrencySafe`；单次时限用 `timeoutMs`。默认值和检查规则见[工具注解与超时](../reference/tools.md#注解与超时)。

三条规则：

- 插件 ID 和会话 ID 从 `context` 里取，不要让模型当参数传进来。
- 工具调用成功，不等于数据已经保存。保存发生在回合结束时。
- 只读数据的工具直接返回内容就行，不需要 `withPendingProposals`。

> [!NOTE]
> `makeProposal` 补齐请求的 ID、来源和回合信息。游戏里的随机数用 `context.random`；请求 ID 由 SDK 生成。

`schemas/note.schema.json` 描述一条记录的形状。世界包往这个数据空间导入内容时按它检查，见[进阶 · 数据契约与世界导入](./advanced.md#数据契约与世界导入)。工具参数由上面的 `parameters` 检查；这个例子没有声明 `datasets`，仅有 `contributes.data` 不会为工具写入启用数据集校验。要让提交边界也检查记录，声明[数据集](../reference/plugins.md#数据集contributesdatasets)，并保持参数、导入和数据集 schema 一致：

```json
{
  "type": "object",
  "required": ["id", "text"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 }
  }
}
```

## 4. 写入口文件

`server/index.js`：

```js
import makeSaveNote from "../tools/save-note.js";

export default function register(covel) {
  covel.registerTool(makeSaveNote(covel.toolkit));
}
```

`covel.toolkit` 就是上一步用到的那组帮手。

入口注册变了以后，在仓库根目录运行：

```bash
pnpm plugin:extract ~/.covel/plugins/notebook
pnpm plugin:extract ~/.covel/plugins/notebook --check
pnpm plugin:extract ~/.covel/plugins/notebook --check --json
```

第一条命令在作者本机运行入口工厂，把 `tools`、`actions`、`services`、`forms`、`wires`、`hooks` 六组注册写回根 `PLUGIN.md` 的 `contributes`，并打印变化的键。一致时显示 `Declarations are in sync.`。列表按首次注册顺序去重；普通 hook 写成事件名，其他阶段写成 `{ event, enforce }`。空列表的键会删除。注释、其他字段和 Markdown 正文保留。

`--check` 不写文件，按键显示 `-` 移除的名字和 `+` 新增的名字；只有顺序或写法变化时单独说明。有漂移时退出 1，一致时退出 0，适合 CI。`--json` 输出 `extracted` 和 `drift`。提取失败退出 1，参数错误退出 2。

扩展注册和命令元数据只报告，不改写：`extensions` 可能带声明专用的选项，`commands` 没有入口注册方法。这些声明仍由作者维护。只改 canonical `PLUGIN.md`；`PLUGIN.<locale>.md` 若带上述注册列表、`extensions` 或 `commands`，会报告文件名并保持原样。本地化的 `contributes.prompt` 可以保留。

> [!CAUTION]
> 这个命令以你的权限执行插件入口代码，只用于你自己的包。它记录注册，不调用工具、动作、服务或 hook 的处理函数；入口在注册时调用 `covel.http` 等宿主能力会报错。工厂抛错、入口路径逃出包目录或 frontmatter 带可执行指令时，不写回文件。安装和审批仍只读取静态声明，加载时仍做[双向核对](../reference/plugins.md#contributes-字段)。

## 5. 校验和离线运行

```bash
pnpm validate:plugin ~/.covel/plugins/notebook
```

```text
✓ Static package validation: /Users/you/.covel/plugins/notebook
  languages: text en; instructions en
```

校验不运行你的代码。要确认工具真的被注册、真的能写入，加一个离线用例。`tests/runtime-cases.json`：

```json
{
  "cases": [
    {
      "name": "saves-one-note",
      "runtimeId": "notebook",
      "message": "The north gate is locked at dusk.",
      "llmResponses": [
        {
          "content": null,
          "finishReason": "tool_calls",
          "toolCalls": [
            {
              "id": "tc-1",
              "name": "save-note",
              "arguments": "{\"id\":\"gate-is-locked\",\"text\":\"The north gate is locked at dusk.\"}"
            }
          ]
        }
      ],
      "expect": {
        "runtimeResults": [{ "runtimeId": "notebook", "status": "success" }],
        "pluginData": [
          { "namespace": "notes", "key": "gate-is-locked", "field": "text" }
        ]
      }
    }
  ]
}
```

这个用例假装模型调用了一次 `save-note`，然后检查 `notes` 里有没有这条记录。运行它：

```bash
pnpm test:runtime -- notebook --pretty
```

输出的开头：

```json
{
  "status": "ok",
  "mode": "mock",
  "pluginId": "notebook",
  "cases": [
    {
      "name": "saves-one-note",
      "status": "passed",
```

往下可以看到保存下来的数据：

```json
"pluginData": {
  "notes": [
    {
      "key": "gate-is-locked",
      "value": {
        "id": "gate-is-locked",
        "text": "The north gate is locked at dusk."
      }
    }
  ]
},
```

到这里，工具已经跑通了。进游戏的方法和[第一个插件](./first-plugin.md)的最后一步相同。用例文件的全部写法见[插件测试](./testing.md)。

## 模型只能通过工具写入

agent 的最后一条回复里即使写了看起来像“要保存的数据”的字段，也不会生效。下面这些字段会被 Covel 去掉，并在服务端日志里记一条警告：

`statePatches`、`pluginData`、`notifications`、`assetGenerations`、`interactions`、`ui`，以及带 `topic` 的 `events`。

要让 agent 写东西，就给它一个工具，并列进 `agent.tools`：

| 想做的事           | 工具                                   |
| ------------------ | -------------------------------------- |
| 写自己的数据       | 自己的工具，或内置的 `plugin-data-set` |
| 发一个事件         | 内置的 `emit-event`                    |
| 给玩家一条通知     | 内置的 `create-notification`           |
| 向玩家要结构化输入 | 内置的 `create-form`                   |

想要求 agent 每次运行都必须成功调用一次工具，写 `completion: { require: tool-use }`。这时“没有变化”也要通过工具提交（例如提交一个空列表），否则这次运行算失败。

一个 `plugin.data` 的值最多 256 KiB，见[数据归属](./essentials.md#数据归属)。

## 控制模型看到多少历史

不写 `agent.history` 时，agent 看到整局共用的历史：还没压缩的消息加上压缩后的摘要。它会随着游戏变长。

只处理这一回合内容的 agent 应该限定范围：

```yaml
agent:
  history: { maxTurns: 2 } # 0 means no history
```

| 写法                                  | 效果                                            |
| ------------------------------------- | ----------------------------------------------- |
| `maxTurns: 2`                         | 只保留最近 2 个回合里玩家能看到的消息，不带摘要 |
| `maxTurns: 0`                         | 不带历史                                        |
| `maxTurns: 2, includeSummaries: true` | 最近 2 个回合，再加上摘要                       |

不管怎么设，这些内容都还在：玩家这一回合的输入、这一回合的故事正文、你声明的输入、`io.selfData` 和代码提供的片段。

另外两点：

- 在故事之后运行的 agent（`post-turn`、`audit`），读到的对话以这一回合的故事正文结尾。提示词里说“对话里最后一段故事正文就是这一回合的叙事”即可。需要按字段取值时，仍然读 `runtime-inputs.<名字>.value`。细节见[提示词结构 · 本回合正文](../reference/prompt-structure.md#本回合正文)。
- 提示词里随剧情变化的变量（`{{ player.character }}`、`{{ characters.npcs }}`）会让提示词每回合都不同，模型服务商的缓存就用不上。改法见[提示词结构 · 变量与数据边界](../reference/prompt-structure.md#4-template-变量与数据边界)。

需要长期回顾的插件，把要点存进自己的数据，或者在函数里[分页读取完整记录](#读取完整的故事记录)。

## 加一个动作和玩家命令

动作（RPC action）是界面或命令可以直接调用的一段代码，不经过模型。命令是玩家在输入框里输入的 `/名字`。两者分开声明：一个动作可以只给界面用，不配命令。

在 `PLUGIN.md` 的 `contributes` 里加：

```yaml
contributes:
  actions: [inspect-note]
  commands:
    - name: note
      description: List the saved notes.
      action: inspect-note
```

在入口文件里注册同名的动作：

```js
export default function register(covel) {
  covel.registerTool(makeSaveNote(covel.toolkit));

  covel.registerRpc("inspect-note", async (_payload, ctx) => {
    const rows = await ctx.store.listPluginData("notes");
    return { ok: true, data: rows.map((row) => row.value) };
  });
}
```

注意：

- 界面传来的 `payload` 是外部输入，使用之前要检查。
- 动作的写入是立刻生效的。它不属于某个回合，后面的步骤失败了也不会撤销。要“全部成功才保存”，用手动触发的函数 runtime。
- 动作要很快做完。超过 30 秒这次动作就算失败：`ctx.signal` 中止，之后的 `ctx.store` 调用都会被拒绝。耗时的工作交给写了 `schedule.background: true` 的 runtime。
- 离线运行不支持动作。运行时它会提示 `Unsupported rpc: notebook/inspect-note. Verify with the server.`，这不是错误。动作要在真实的服务端上验证。

## 写一个函数

确定的规则不需要模型。给 runtime 写一个 `function` 块，它就是函数，不再是 agent：

```yaml
runtime:
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@2 }
        select: /narrativeOutput
  function:
    timeoutMs: 30000
    tools: { builtin: [get-character] }
```

代码默认在清单旁边的 `handler.js` 里，放在别处时用 `function.handler` 指向它。不需要别的设置时写 `function: {}`。

`handler.js` 默认导出一个函数：

```js
/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function handler(ctx) {
  const text = String(ctx.inputs?.narrative?.value ?? "");
  const words = text.split(/\s+/).filter(Boolean).length;

  await ctx.pluginData.set("stats", "last-turn", { words });

  return { outcome: "success", value: { words } };
}
```

开头的注释只是给编辑器看的类型提示，不是真的 `import`。

函数的返回值有三个互不相干的部分：

| 字段         | 意思                                        |
| ------------ | ------------------------------------------- |
| `value`      | 业务结果。别的 runtime 通过输入读到的就是它 |
| `effects`    | 要产生的效果：事件、通知、表单等            |
| `completion` | 开局阶段的函数用它报告“完成了”（`"done"`）  |

把效果写在 `value` 里面不起作用。失败时返回 `{ outcome: "failed", error: "原因" }`。

函数里常用的东西：

| 写法                                                                          | 作用                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.inputs.<名字>.value`                                                     | 你声明的输入                                                                                                                                                               |
| `ctx.playerMessage`                                                           | 玩家这一回合的输入                                                                                                                                                         |
| `ctx.playerActions`                                                           | 玩家这一回合解析后的行动（座位、类型、角色、文字、`fields`），见[行动类型](../reference/plugins.md#行动类型contributesactionkinds)；没有玩家输入时是空数组                 |
| `ctx.manualPayload`                                                           | 手动触发时界面传来的数据                                                                                                                                                   |
| `ctx.pluginData.get/list/set/update`                                          | 读写自己的数据，见[改数据](#改数据)                                                                                                                                        |
| `ctx.world`                                                                   | 角色、角色的字段定义、资料库和会话的座位 `seats`。只读。玩家正在扮演的角色见[谁是玩家](#谁是玩家)                                                                          |
| `ctx.userSettings`                                                            | 玩家的设置项                                                                                                                                                               |
| `ctx.random`                                                                  | 随机数。掷骰只用它                                                                                                                                                         |
| `ctx.locale`                                                                  | 这一局游戏的语言                                                                                                                                                           |
| `ctx.tools.call(name, args)`                                                  | 调用 `function.tools` 里列出的工具                                                                                                                                         |
| `ctx.logger`                                                                  | 写插件日志                                                                                                                                                                 |
| `ctx.signal`                                                                  | 运行被取消时得到通知                                                                                                                                                       |
| `ctx.recursiveCall({ playerMessage, manualTrigger: { runtimeId, payload } })` | 在这一回合里调用自己包里的 runtime，见[嵌套调用](../reference/plugins.md#嵌套调用ctxrecursivecall)。跨包协作用[服务或事件](../reference/plugin-extensions.md#选择通信方式) |
| `ctx.recursionDepth`                                                          | 被 `recursiveCall` 嵌套运行时大于 0。只该在顶层做的事，先判断它                                                                                                            |
| `ctx.execution?.sourceTurnId`                                                 | 重试旧回合时是那个回合的 ID。掷骰、揭示用它做键，重试就不会重新抽                                                                                                          |
| `ctx.store.getSession()`                                                      | 这一局的阶段、回合数、语言和开局步骤的进度（只读）                                                                                                                         |

- 上面每个字段都写在 `PluginFunctionContext` 类型里，开头那行类型注释就能让编辑器提示和检查它们。
- 函数能调用的工具写在 `function.tools` 里。函数的时限是 `function.timeoutMs`。这两项不要写进 `agent` 里：函数 runtime 不能有 `agent` 配置。
- 想让下一回合或别的运行读到这次的结果，在这边声明 `io.output.recordAs`，在读的那边声明 `scope: committed` 和同一个 `recordAs`。
- 函数没有组装好的对话。这一回合的内容从 `ctx.playerMessage`、你声明的输入，或者 Covel 提供的 `turn-digest@1` 输入（含 `playerMessage` 和 `narrativeText`）里读。

## 读数据

```js
const notes = await ctx.store.listPluginData("notes"); // [{ key, value }, ...]
const row = await ctx.store.getPluginData("notes", "gate-is-locked"); // { key, value } or null
const value = await ctx.pluginData.get("notes", "gate-is-locked"); // the value itself, or null
const characters = ctx.world?.characters ?? [];
```

这里的数据空间属于当前插件，这一局游戏是哪一局由 Covel 决定。没有“多传一个插件 ID 去读别人数据”的办法。要用别的插件的东西，走输入、服务或扩展，见[插件扩展与通信](../reference/plugin-extensions.md)。

工具和函数读到的角色数据，已经包含这一回合里前面的步骤提出、但还没保存的修改。所以“先写后读”能读到刚写的内容。不要自己绕过它去读已保存的旧数据，也不要把前面步骤的写入请求再提交一遍。

插件数据同样如此：读到的值包含这次执行里同一个插件前面已经完成的 runtime 写下、还没保存的内容。前面的写入在保存时被拒绝的话，读过它的 runtime 也一起作废（故事除外）。规则见[执行内的插件数据可见性](../reference/plugins.md#执行内的插件数据可见性)。

### 谁是玩家

一局游戏可以有多个 `type: player` 的角色（例如一个人同时扮演两个角色）。玩家此刻扮演哪一个，由会话的座位决定，`ctx.world.seats` 里能读到。用 SDK 的辅助函数找它：

```js
import { currentCharacterOf, primarySeat } from "@covel/plugin-handlers-utils";

const player = currentCharacterOf(
  primarySeat(ctx.world.seats),
  ctx.world.characters,
  ctx.world.seats,
); // the character record, or undefined when nobody is seated or bound
```

- 不要用 `ctx.world.characters.find((c) => c.type === "player")`：有多个玩家角色时它只找到第一个。
- `seatCharacterIds(seat, characters, seats)` 给出一个座位绑定的全部角色 `id`，玩家控制的其他角色也在里面。
- 座位只读。玩家换当前角色后，下一回合起读到新的角色。绑定和当前角色的规则见[座位](../reference/world-model.md#座位)。

### 读取完整的故事记录

`ctx.store.readTurnMessages` 按页读取已保存的全部消息，包括已经被摘要替代的原文。把读到的位置存起来，下次只读新增的：

```js
const saved = await ctx.store.getPluginData("progress", "cursor");
let after = saved?.value ?? undefined;
let page;
do {
  page = await ctx.store.readTurnMessages({ after, limit: 200 });
  for (const message of page.messages) collect(message); // { turnId, role, content, compacted, ... }
  after = page.cursor ?? undefined;
} while (page.hasMore);
await ctx.pluginData.set("progress", "cursor", after ?? null);
```

- `limit` 默认 100，最大 500。
- `cursor` 是一个不用理解的字符串，指向最后读到的消息。这一页是空的时候，它原样返回你传入的 `after`。
- `hasMore` 为 `false` 表示已经读到末尾。
- 消息按保存的先后返回。后台执行的消息可能比它前面的消息时间更早，但它保存得晚，所以仍然排在你存下的位置之后，不会漏掉。
- 它只返回已保存的消息，不包含正在运行的这一回合。

## 改数据

`ctx.pluginData.set(namespace, key, value)` 写入整个值。值是从已有的值算出来的（金币减 3、往列表里加一项）时，改用 `ctx.pluginData.update` 交一串操作：

```js
try {
  await ctx.pluginData.update("wallet", "gold", [
    { op: "inc", by: -3, min: 0 },
  ]);
} catch (error) {
  // The ops fail against the current value: here, not enough gold.
  return { outcome: "failed", error: "not enough gold" };
}
const gold = await ctx.pluginData.get("wallet", "gold"); // the value after the ops
```

内置的 [inventory 台账](../../plugins/inventory/lib/update-inventory.js)和 [affinity 工具](../../plugins/affinity/tools/update-affinity.js)是数据集操作式写入的完整例子：已有记录的计数用 `inc`，新记录用 `set`，好感档位、进度条等派生字段由读取值加增量算出，再用 `merge` 写入。并发提交时计数增量会累加，派生字段和整数组写入的历史仍取工具预测的值，可能落后于最终计数。

- 操作在提交时作用在最新存的值上。两次运行同时各扣 3，两次都会扣到，不会一次覆盖另一次。
- 调用时先拿当前看到的值试一遍。失败（比如结果小于 `min`）就直接抛错，什么都不写，你可以当场处理。
- 它不返回新值。想要新值，再 `get` 一次。
- 可用的操作有 `set`、`merge`、`inc`、`append`、`insert`、`remove`、`upsertItem`、`delete`。提交时的规则见[事务 · 操作式写入](../reference/transactions.md#操作式写入plugindataupdate)。

## 向玩家要输入：表单

需要玩家填结构化的内容（建角色、分配点数）时用表单。

- agent：调用内置工具 `create-form`。
- 函数：在 `effects.interactions` 里返回 `{ type: "form", interactionId, title, fields, submitLabel }`。

可选的 `notice` 是字段上方的一行说明，用来告诉玩家为什么又看到这张表单（例如上一次提交不能用）。用这一局游戏的语言写。

表单自带必填、范围和选项的检查。更复杂的规则写成校验器。三处要对上：

1. `PLUGIN.md` 的 `contributes.forms` 里列出校验器的名字。
2. 表单里写 `validation: { name: "point-buy" }`。
3. 入口文件里注册它：

```js
covel.registerFormValidator("point-buy", (values, data, context) => {
  const text = "Strength is at most 15.";
  const issues = [];
  if (Number(values.strength) > 15) {
    issues.push({
      field: "strength",
      message: context.messages?.translations?.[text] ?? text,
    });
  }
  return issues.length > 0 ? issues : undefined;
});
```

校验器必须是同步的，并且不产生别的效果。第三个参数里有这一局游戏的语言，以及你在 `locales/` 里为这种语言写的译文。

| 校验器返回                        | 玩家看到                               |
| --------------------------------- | -------------------------------------- |
| `undefined`                       | 提交成功                               |
| 一个字符串                        | 整张表单的一条错误                     |
| `{ field, message }` 或它们的数组 | 每个出错的字段下面各一条，一次全部列出 |

被拒绝的提交不写入任何内容，也不开始回合，玩家填的值保留。在事件流里它是一个 `code: "form_rejected"` 的 `error.occurred`。

同一张表单只能回答一次。再次提交得到 `code: "interaction_already_submitted"`。提交接口和字段见[工具参考](../reference/tools.md)和 [API 参考](../reference/api.md)。完整的例子见[配点表单](../recipes/point-buy.md)。

## 没有按预期工作时

| 现象                                            | 原因和处理                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 校验通过，但插件加载失败                        | 入口文件注册的工具、动作名和 `contributes` 里的不一致                                     |
| 入口文件报找不到 `@covel/plugin-handlers-utils` | 确认由 Covel 加载，或在仓库测试环境解析公开 SDK；独立运行 Node 不会自动获得宿主提供的模块 |
| 离线用例里工具调用被拒绝                        | 假模型传的 `arguments` 不符合工具的 `parameters`                                          |
| 工具调用成功，数据却没有保存                    | 这个 runtime 最后以失败结束，它的写入就都不保存。在调试页面看它失败的原因                 |
| 用例提示 `Unsupported rpc`                      | 正常。离线运行不支持动作，到真实的服务端上验证                                            |
| 函数里 `ctx.tools.call` 报工具不可用            | 工具没有列在 `function.tools` 里                                                          |
| 模型在回复里写了数据，但什么都没发生            | 回复里的数据字段不生效。给它一个工具                                                      |
| 声明了 `require: tool-use` 的 agent 总是失败    | “没有变化”时也必须成功调用一次工具                                                        |

## 接下来

- 给工具和函数写单元测试：[插件测试](./testing.md)
- 多个 runtime 配合、让世界包提供数据、访问外部接口：[进阶](./advanced.md)
- 加一块面板显示这些记录：[插件界面](./ui.md)
- 可以参考的内置插件代码：[guide 的工具](../../plugins/guide/tools/generate-guide.js)、[world-time 的动作](../../plugins/world-time/rpc/time.js)
