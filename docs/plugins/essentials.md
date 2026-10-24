# 写插件要知道的规则

这一页收集每个插件作者都会遇到的规则：哪些东西要声明、模型能用哪些工具、怎样和别的插件配合、数据归谁、提示词和译文写在哪里。它按问题组织，遇到问题时回来查就行。

读这一页之前，先做完[第一个插件](./first-plugin.md)。那一页带你跑通一遍；这一页解释跑通之后要守的规矩。

## 接下来读哪一页

| 你要做的事                             | 读这一页                             |
| -------------------------------------- | ------------------------------------ |
| 只写配置和提示词，不写代码             | [只有提示词的插件](./prompt-only.md) |
| 让模型用你写的工具，或者写一个函数     | [带本地代码的插件](./local-code.md)  |
| 多个 runtime、可导入的数据、权限、发布 | [进阶](./advanced.md)                |
| 把提示词写好                           | [提示词写法](./prompt-style.md)      |
| 给插件写测试                           | [插件测试](./testing.md)             |
| 加一块界面面板                         | [插件界面](./ui.md)                  |

全部字段见[插件字段参考](../reference/plugins.md)。

## 最小闭环

每次改完插件，都走这三步：生成（只做一次）、校验、离线运行。

写给自己或社区用的插件，放在用户插件目录里，不需要安装依赖：

```bash
pnpm create-plugin my-plugin
pnpm validate:plugin ~/.covel/plugins/my-plugin
pnpm test:runtime -- my-plugin --pretty
```

要放进 Covel 仓库的内置插件，生成到 `plugins/` 下，带一个本地工具和单元测试：

```bash
pnpm create-plugin my-plugin --with-tools
pnpm install
pnpm validate:plugin plugins/my-plugin
pnpm --filter @covel/plugin-my-plugin test
```

带工具模板的开发依赖使用 TypeScript 7.0.2 和 Zod 4.6.7 或更高的兼容版本。Zod 的最低版本与宿主 SDK 一致，避免 TypeScript 7.1 的递归 JSON 类型错误；发布时仍由宿主提供 Zod，不随插件安装依赖。Vitest 随工作区同步更新，版本范围见[模板清单](../../templates/plugin-with-tools/package.json)。

生成命令不会提问，用参数决定生成什么：

| 参数               | 作用                                                                |
| ------------------ | ------------------------------------------------------------------- |
| 不带参数           | 一个函数 runtime（`note`）加一个 agent runtime（`analyst`）         |
| `-r name:type,...` | 自己列出 runtime。`type` 是 `function` 或 `agent`，不写时是 `agent` |
| `-t <dir>`         | 生成到指定目录，而不是 `~/.covel/plugins`                           |
| `--with-tools`     | 生成到仓库的 `plugins/` 下：一个 runtime，加 `tools/` 和单元测试    |

一个最小的插件只有一个文件：`PLUGIN.md`。`README.md` 写给维护者看，可以不写；`package.json` 只在插件要声明开发依赖或作为仓库的 workspace 成员时才需要。下面是一份完整的 `PLUGIN.md`，它在每回合的故事之后让模型补一句观察：

```yaml
---
description: Adds a brief observation after narration.
requires: [narrative-engine@1]
runtime:
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
---
Write one observation grounded in runtime-inputs.narrative.value.
```

没写的字段由 Covel 推出或用默认值：插件 ID 是文件夹名；没有 `function` 块，所以它是 agent；这个 runtime 每回合自动运行，用 `plugin` 用途的模型，它的输出不是故事正文。和默认值一样的字段不用写，写了 `pnpm validate:plugin` 会提醒；默认值和 Covel 推出的字段见[插件参考 · 默认值](../reference/plugins.md#默认值)。

最容易出错的几条规则：

- 插件 ID 就是文件夹名。写了 `id` 时，它必须和文件夹名一样。
- `runtimes/` 下每个目录都要有 `RUNTIME.md`，共享代码放在根目录的 `lib/`。缺清单的路径会报给作者，其他 runtime 仍可加载；详见[插件规范](../reference/plugins.md)。
- 只有一个 runtime 时，把它写在 `PLUGIN.md` 的 `runtime:` 里。有多个时，每个放在 `runtimes/<名字>/RUNTIME.md`。两种写法不能同时用，否则校验报 `inline runtime and runtimes/ cannot coexist`。
- 版本只写在 `PLUGIN.md` 的 `version` 里，`package.json` 不写版本。插件带 `package.json` 时，它必须写 `"type": "module"`：插件包只支持 ESM，缺了这一行校验和安装都会拒绝。没有 `package.json` 的插件，Covel 照样把它的 `.js` 文件当作 ES module 加载。

`pnpm create-plugin` 的每种模式都把 `PLUGIN.md` 的版本设为 `0.1.0`。发布新版本时改这一处，再用 `pnpm validate:plugin <插件目录>` 检查。

校验通过后，在游戏的准备页选中插件并授权，它才会运行，见[第一个插件](./first-plugin.md)的最后一步。打包和安装见[打包并试装](../ship/package.md)。

## 我注册的东西要在哪里声明

插件贡献的所有东西，都写在 `PLUGIN.md` 的 `contributes` 里。你在代码里注册的名字，必须和这里写的一样：多一个、少一个，插件都加载失败。

代码写在入口文件里。入口文件默认是 `server/index.js`，放在那里就不用写 `entry`；放在别处时，`PLUGIN.md` 用 `entry` 指向它：

| 你在入口文件里调用                     | 要在 `contributes` 里写 |
| -------------------------------------- | ----------------------- |
| `covel.registerTool(...)`              | `tools`                 |
| `covel.registerRpc(name, ...)`         | `actions`               |
| `covel.registerService(...)`           | `services`              |
| `covel.provideExtension(...)`          | `extensions`            |
| `covel.on(event, ...)`                 | `hooks`                 |
| `covel.registerFormValidator(name, …)` | `forms`                 |
| `covel.registerWires(...)`             | `wires`                 |

另外三项只需要声明，不需要代码：

- `contributes.commands`：玩家在输入框里用的命令。每条命令指向一个 `actions` 里的名字，所以那个名字也必须出现在 `actions` 里。
- `contributes.prompt`：固定的提示词片段，见[只有提示词的插件](./prompt-only.md#加一段固定的提醒)。
- `contributes.events`：插件会发出的事件。

事件的名字在一局游戏里只能有一个声明者。两个启用的插件声明了同一个名字时，后一个会被排除出这一局，原因是 `event-topic-conflict`。所以给事件名加上自己插件的前缀：

```yaml
contributes:
  events:
    - topic: my-plugin.noted
      schema: ./schemas/noted.event.json
      description: Emitted after a note is saved.
```

> [!NOTE]
> 校验命令只读文件，不运行入口文件。它查不出“声明了但代码里没注册”。这种错误在插件加载时才出现，用[离线运行](./testing.md)可以提前发现。

## 模型能用哪些工具

有两份清单，用途不同：

| 清单                | 写在哪里             | 意思                        |
| ------------------- | -------------------- | --------------------------- |
| `contributes.tools` | `PLUGIN.md`          | 这个插件注册了哪些工具      |
| `agent.tools`       | agent runtime 的配置 | 这个 agent 可以调用哪些工具 |

`agent.tools` 分两组：`builtin` 是 Covel 自带的工具，`plugin` 是你自己的工具。

```yaml
agent:
  tools:
    builtin: [plugin-data-set]
    plugin: [save-note]
```

规则：

- 模型只能调用这里列出的工具。没列出的，它看不到。
- 插件只有一个 runtime（写在 `runtime:` 里）并且没有写 `agent.tools.plugin` 时，这个 runtime 得到 `contributes.tools` 里的全部工具，不用再列一遍。
- 写了 `plugin` 就以写的为准。`plugin: []` 表示一个自己的工具都不给。
- 有多个 runtime 的插件里，每个 runtime 各自列出要用的工具。没有 runtime 使用的内部 helpers 不要注册成工具，也不要列进 `contributes.tools`。
- 工具名只在自己的插件里唯一。一个插件调用不了另一个插件的工具，要用服务，见[插件扩展与通信](../reference/plugin-extensions.md)。

内置工具的清单见[工具参考](../reference/tools.md)。

调用一个工具就结束的 agent 写 `agent.finishWith: <工具>`。完成条件的完整写法见[插件参考](../reference/plugins.md#完成条件agentfinishwithagentcompletion)：`completion.require: tool-use` 配合 `afterTools` 时，查询工具不能代替声明的完成工具。

## 怎样用别的插件的结果

按能力找，不按名字找。能力有一个带版本号的名字，例如 `narrative-engine@1`。要读“写故事的插件”这一回合的输出，写三处：

```yaml
requires: [narrative-engine@1]
runtime:
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
```

| 这一段                    | 作用                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `requires`                | 启用这个插件时，Covel 会确保有一个提供这项能力的插件也被启用   |
| `io.inputs.<名字>.from`   | 读取那个插件这一回合的结果                                     |
| `select`                  | 只取结果里的一部分                                             |
| `required`（默认 `true`） | 上游失败或不存在时，这个 runtime 不运行；写 `false` 时照常运行 |

读到的值在提示词里是 `runtime-inputs.narrative.value`，在函数里是 `ctx.inputs.narrative.value`。

`requires` 只写缺了就不能用的能力。写了 `required: false` 的输入不用写进 `requires`：有提供者时读到它的结果，没有时照常运行。反过来，你的 runtime 用 `io.output.contract` 发布的能力，插件会自动提供，不用写进 `provides`。

还有两个只管先后顺序的字段：`schedule.needs` 要求上游成功，`schedule.after` 只要求上游已经结束。必需的输入（不写 `required` 时就是）已经带有“上游成功”这个条件，不用再写一遍 `needs`。

> [!IMPORTANT]
> 跨插件的引用只能写能力名。`needs`、`after`、`io.inputs` 里写别的插件的 runtime 名（例如 `other-plugin/some-runtime`）会让清单加载失败。同一个插件内部的 runtime 之间可以直接用 runtime 名。

同一项能力可以有几个提供者。`cardinality: one`（默认）表示“只要一个”，`cardinality: all` 表示“全都要”。想和提供某项能力的其他插件互斥，在 `PLUGIN.md` 写 `conflicts`。

由事件触发的 runtime 也可以排先后：同一个事件触发的几个 runtime 之间，`needs` 和 `after` 照常生效，没有依赖的仍然同时运行。依赖不会替你触发一个没有被事件匹配到的 runtime。后台运行的 runtime 之间不能这样排序，要接力就发一个后续事件，或者读对方已经保存的输出。

发布输出时，在根 `contracts` 声明公共 schema，并让 guard 跳过时的输出也符合它。已有资料可能比模型生成的资料少，不要把生成工具的数量要求放进公共输出；见[发布输出契约](../reference/plugins.md#发布输出契约)。

各种通信方式（同一回合的结果、已保存的结果、事件、服务、扩展点）见[插件扩展与通信](../reference/plugin-extensions.md)。

## 有些内容不能让玩家提前看到

处理隐藏剧情或谜底的 runtime 声明 `io.concealed: true`：

```yaml
io:
  concealed: true
```

声明之后：

- 它的提示词、模型回复、工具参数、工具结果和输出，不会出现在调试记录、实时进度和玩家能看到的执行历史里。只留下名称、状态、耗时和用量。
- 它失败时，玩家看到一句固定的通用提示。真实原因只写进服务端日志。
- 它输出的文字不写入对话记录，别的 runtime 也读不到。表单和界面块照常显示。

`io.concealed: true` 不能和 `io.visibility: story` 一起用，加载会失败：故事 runtime 的文字本来就是给玩家读的。

要把隐藏内容交给别的插件，用输出能力传过去，由接收的插件存进它自己的隐藏数据空间。例子见 [story-events 的 plot runtime](../../plugins/story-events/runtimes/plot/RUNTIME.md) 和[世界数据 · 隐藏数据](../reference/world-data.md#隐藏数据visibility-hidden)。

## 数据归属

### 我的数据放在哪里

每个插件有一块自己的数据，按“数据空间（namespace）+ 键”存取。别的插件读不到它。

| 在哪里                | 怎样读                                                                  | 得到什么                                    |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| 函数、guard、扩展代码 | `ctx.pluginData.get(namespace, key)`                                    | 存下的值本身；没有时是 `null`               |
| 同上                  | `ctx.pluginData.list(namespace)`                                        | 一组 `{ key, value, createdAt, updatedAt }` |
| 函数、RPC             | `ctx.store.getPluginData(namespace, key)` / `listPluginData(namespace)` | `{ key, value }` 这样的行；没有时是 `null`  |
| agent 的提示词        | 在 `io.selfData` 里列出数据空间                                         | 这个空间的内容被放进提示词                  |

写入有两种方式：函数里调用 `ctx.pluginData.set(namespace, key, value)`，或者由工具提交一条“我想写这个”的请求（proposal）。两者都在回合结束时一起保存。runtime 失败时，它的写入一条都不会留下。

要记住的限制：

- 一个值转成 JSON 后最多 256 KiB。超过时写入失败，错误里写明插件、`namespace/key`、实际大小和上限。原值不变，也不会被截断。会不断变长的列表要拆到多个键里，或者自己裁剪。
- 以 `_` 开头的数据空间留给 Covel 自己用，插件不能写。
- 两个插件要共享数据，必须通过公开的能力，不能去读对方的数据空间。

### 角色归谁

角色、角色的字段定义、资料库由 Covel 保管，所有插件共用。读它们用 `ctx.world`。想改，也要提交请求。不要把角色复制一份到自己的数据空间里，也不要去读别的插件的私有数据。

### 想让世界作者提供这份数据

在 `contributes.data` 里给数据空间声明 `version`、`schema` 和 `accepts`，世界包就能把内容导入进来。再加上 `authoring`，世界作者和创作工具就知道这份内容怎么写。做法见[进阶 · 数据契约与世界导入](./advanced.md#数据契约与世界导入)和[世界数据参考](../reference/world-data.md)。

如果导入的记录里有嵌套的列表，并且列表项不是用 `id` 而是用别的字段（例如 `label`）区分，声明 `authoring.source.localeArrayKeys: [label]`。这样主文件调整了列表顺序之后，译文仍然对得上同一条记录。

记录引用维度并比较其值时，用 [`authoring.references` 的 `within` 和 `values`](../reference/plugins.md) 声明路径与候选值，让世界校验和导入在写入前发现错误。

### 想让记忆检索查到这份数据

在数据空间的声明里加 `search: { text: <字段名> }`，见[可检索的数据](../reference/plugins.md#可检索的数据)。

记忆本身归 memory 插件管。世界要自定义记忆块时，通过 `memory.blocks@1` 导入，见[世界数据参考](../reference/world-data.md)。清单里没有 `memoryBlocks` 或 `summaryFocus` 这样的字段。

## 提示词与本地化

### 提示词写在哪里

| 内容                   | 写在哪里                                                        |
| ---------------------- | --------------------------------------------------------------- |
| agent 的提示词         | 它所在的 `PLUGIN.md` 或 `RUNTIME.md` 的正文                     |
| 固定的附加片段         | `PLUGIN.md` 的 `contributes.prompt`                             |
| 每回合内容都不同的片段 | 代码提供，见[插件扩展与通信](../reference/plugin-extensions.md) |

`contributes.prompt` 里的片段属于整个插件，不能只给某一个 runtime。只对一个 runtime 有效的规则，写进那个 runtime 的正文。

怎样把正文写好，见[提示词写法](./prompt-style.md)。

### 用什么语言写

| 内容                       | 语言和位置                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| 名称、说明、设置项的标签   | 英文，写在 `PLUGIN.md` / `RUNTIME.md` 里                         |
| 它们的译文                 | `locales/<语言>.yaml`，任何语言都可以加                          |
| 提示词正文                 | 英文，写在 `PLUGIN.md` / `RUNTIME.md` 的正文里                   |
| 提示词的简体中文版（可选） | `PLUGIN.zh.md` / `RUNTIME.zh.md`，只写正文和固定片段的 `content` |

要点：

- 简体中文的游戏读 `*.zh.md`。其他语言的游戏都读英文正文。除了中文，不需要也不会读取别的语言的提示词文件。
- 模型按这一局游戏的语言输出。Covel 在每个 agent 的提示词开头加了“用什么语言输出”的指令，所以正文里不要再写一遍。
- 中文版不能改变工具、依赖、能力、片段的 ID 和位置，只能换文字。没写的部分沿用英文版。
- 代码里生成的文字（例如工具返回给模型的消息）用 `ctx.locale` 选语言。不要只翻译了清单，却漏掉工具的返回值。
- 仓库内置插件的 agent 提示词必须有中文版。改了任一语言之后运行 `pnpm check:prompts`，两边都改完再运行 `pnpm prompts:lock`。社区插件的中文版是可选的。

完整规则见[多语言参考](../reference/i18n.md#2-本地化插件)和[提示词结构](../reference/prompt-structure.md)。

## 验证与发现

### 校验检查什么

```bash
pnpm validate:plugin ~/.covel/plugins/my-plugin
```

参数可以是插件的文件夹、它的 `PLUGIN.md`，或者某个 `RUNTIME.md`。三种写法都检查整个插件。

它只读文件，不运行入口文件、guard 和函数。它检查字段、阶段、工具名、引用的文件、输入引用的能力和 schema。出错时指出是哪个文件的哪个字段。

读取“已保存结果”的输入（`scope: committed`）拿到的是完整结果，不能写 `select`。要只取一部分，就读同一回合的结果（默认）。

### 怎样查一个插件声明了什么

运行中的服务端提供三个查询接口：

| 接口                              | 返回                                                |
| --------------------------------- | --------------------------------------------------- |
| `GET /api/plugins/:id`            | 这个插件的能力、设置、runtime、工具、界面和数据声明 |
| `GET /api/framework/capabilities` | Covel 提供的全部基础能力和查询入口                  |
| `GET /api/worlds/:id/plugin-plan` | 这个世界默认会启用哪些插件                          |

### 怎样限定适用的 Covel 版本

在 `PLUGIN.md` 写 `covel: ">=0.0.45"` 这样的范围。范围之外的 Covel 拒绝安装这个插件，已经装上的也不加载。`pnpm create-plugin` 生成的独立插件已经把生成时的版本写成了下限。写法见[合集 · 版本范围](../ship/collections.md#版本范围)。

### 怎样让玩家知道是谁做的

在 `PLUGIN.md` 写 `version`、`author`、`license`、`homepage`。作者名、一段写给玩家的话和几个 `https` 链接会显示在准备页和已安装列表里。玩家点开链接之前会看到第三方链接的提示。字段和限制见[作者信息](../reference/plugins.md#作者信息)。

## 写代码时可以用什么

插件的代码只依赖公开的 SDK `@covel/plugin-handlers-utils`，不要引用 Covel 内部的包、数据库表或前端组件。

> [!IMPORTANT]
> 这个 SDK 没有发布到 npm，安装插件时也不会执行 `npm install`。Covel 给每个插件提供 SDK（包括 `/dimensions`、`/prompts` 子入口）和 `zod`，插件代码直接 `import` 就行，内置插件和装在用户目录里的插件一样。开发时要装它们，就写进 `package.json` 的 `devDependencies`：安装器拒绝非空的 `dependencies`。用到的其他库要打包进插件。

常用的帮手：

| 需要                     | 用什么                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 掷骰和其他随机数         | `ctx.random`（工具里是 `context.random`，生成 ID 时必须传给 `shortId` 的第四个参数）                     |
| 多语言文本取当前语言     | `resolveI18nText` / `resolveI18nDeep`                                                                    |
| 估算一段文字的 token 数  | `estimateTokens`                                                                                         |
| 给自己的文本按相关度排序 | `rankTexts` / `searchTerms` / `searchExcerpt`，不调用模型                                                |
| 给 ID、键、时间戳排序    | `compareText`                                                                                            |
| 加载自己的提示词模板     | `@covel/plugin-handlers-utils/prompts` 的 `createPromptLoader(root)`，只读 `<name>.md` 和 `<name>.zh.md` |
| 表单和角色字段校验       | SDK 里的表单工具和角色字段校验                                                                           |

两条和可重复性有关的规则：

- 随机数只用 `ctx.random`，不要用 `Math.random` 或 `node:crypto`。这样用 `COVEL_RANDOM_SEED` 启动的测试服务端才能让同一局重复出同样的结果。
- 排序用 `compareText`，不要用不带语言参数的 `localeCompare`。后者的结果随服务器的系统语言变化。

不要把记账用的字段交给模型：会话 ID、记录的 UUID、时间戳。Covel 放进提示词的内容已经去掉了它们；你自己拼的文字用 `modelFacingJson` 处理。说到“哪一回合”时用回合序号。

## 没有按预期工作时

| 现象                                                 | 原因和处理                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 校验报 `inline runtime and runtimes/ cannot coexist` | `PLUGIN.md` 里写了 `runtime:`，同时又有 `runtimes/` 文件夹。只留一种            |
| 校验报某个字段 `Invalid option` 或 `Invalid input`   | 字段的值或形状不对。按报出的字段路径对照[插件字段参考](../reference/plugins.md) |
| 校验通过，但插件加载失败                             | 入口文件注册的名字和 `contributes` 不一致                                       |
| 模型不调用我的工具                                   | 工具没有列在 `agent.tools.plugin` 里（多 runtime 的插件必须列）                 |
| 插件在这一局里被排除，原因是 `event-topic-conflict`  | 事件名和另一个插件重复。给事件名加上自己的前缀                                  |
| 写入失败，提示超过大小上限                           | 一个值超过了 256 KiB。拆成多个键                                                |
| 中文的游戏里，提示词的修改没有生效                   | 只改了英文正文。中文的游戏读的是 `*.zh.md`                                      |

## 接下来

- 只写配置和提示词：[只有提示词的插件](./prompt-only.md)
- 写工具和函数：[带本地代码的插件](./local-code.md)
- 测试：[插件测试](./testing.md)
- 发给别人：[验证与分发](../ship/index.md)

只使用当前声明的输入和数据形状：投影后的叙事输入是字符串，骰子回执带 `checks` 数组，`pluginData.get()` 直接返回存储值。版本变更见[插件契约](../reference/plugins.md#契约版本策略)，不要为了保留开发数据再加包装或回退分支。
