# 进阶：多个 runtime、数据契约、权限和发布

这一页讲一个插件长大之后会用到的东西：把工作拆成几个 runtime、让世界包给插件提供数据、在后台运行、访问外部接口、拦截工具调用，以及发布前要填的字段。例子是一个插件“fact-index”：一个 agent 从故事里提取事实，一个函数按需查询。

读这一页之前，先读完[带本地代码的插件](./local-code.md)。每一节可以单独读，用到哪节读哪节。

## 多个 runtime 的布局

一个插件有多个 runtime 时，每个 runtime 住在 `runtimes/` 下自己的文件夹里：

```text
fact-index/
├── PLUGIN.md                    包的身份、能力、共用的声明
├── package.json
├── README.md
├── server/index.js              可选：入口文件
├── schemas/facts.schema.json
└── runtimes/
    ├── extract/
    │   └── RUNTIME.md           agent：提取事实
    └── query/
        ├── RUNTIME.md           函数：查询
        └── handler.js
```

`PLUGIN.md` 只说“这个包是什么”，不再有 `runtime:`：

```yaml
---
id: fact-index
kind: plugin
description: Extracts and retrieves narrative facts.
provides: [facts.index@1, facts.query@1]
requires: [narrative-engine@1]
contributes:
  data:
    facts:
      version: 1
      accepts: [facts.index@1]
      schema: ./schemas/facts.schema.json
---
```

`runtimes/extract/RUNTIME.md` 是一个 agent。它没有 `id`，文件夹名就是它的名字，完整的名字是 `fact-index/extract`：

```yaml
---
type: agent
schedule: { stage: post-turn }
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@1 }
      required: true
      select: /narrativeOutput
  output:
    contract: facts.index@1
    schema: ../../schemas/facts.schema.json
    recordAs: extracted-facts
  visibility: plugin
agent: { model: plugin }
---
Extract only the facts that `runtime-inputs.narrative.value` states.
```

`runtimes/query/RUNTIME.md` 是一个手动触发的函数：

```yaml
---
type: function
schedule:
  trigger: { type: manual }
  manual: { execution: sync }
io:
  output: { contract: facts.query@1 }
  visibility: plugin
function:
  handler: ./handler.js
  timeoutMs: 90000
---
```

这里新出现的东西：

| 这一段                      | 意思                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `provides`                  | 这个插件对外提供的能力。别的插件可以 `requires` 它们                                  |
| `io.output.contract`        | 这个 runtime 的输出就是这项能力的内容。它必须出现在 `provides` 里                     |
| `io.output.schema`          | 输出要符合的形状。不符合时这次运行失败                                                |
| `io.output.recordAs`        | 把输出保存下来，取一个名字。以后的回合可以用 `scope: committed` 读到它                |
| `schedule.manual.execution` | `sync` 是调用方等它完成；`background` 是放到后台，见[后台工作与失败](#后台工作与失败) |

规则：

- 同一个插件里，不能有两个 runtime 输出同一项能力。
- 路径相对于文件所在的位置。`RUNTIME.md` 里的 `./handler.js` 在它自己的文件夹里；`PLUGIN.md` 里的路径从包的根目录算起。路径和符号链接都不能指到包外面。
- `RUNTIME.md` 里不能写 `contributes`、`id` 这些属于整个包的字段。设置项、数据声明、工具清单都写在 `PLUGIN.md` 里，所有 runtime 共用。
- 多 runtime 的插件里，每个 agent 用 `agent.tools.plugin` 列出自己要用的工具。

校验时，传文件夹、`PLUGIN.md` 或任何一个 `RUNTIME.md` 都会检查整个包：

```bash
pnpm validate:plugin ~/.covel/plugins/fact-index
pnpm validate:plugin ~/.covel/plugins/fact-index/runtimes/query/RUNTIME.md
```

```text
✓ Static package validation: /Users/you/.covel/plugins/fact-index
  languages: text en; instructions en
```

离线运行其中一个 runtime 时，写完整的名字：`pnpm test:runtime -- fact-index/query --pretty`。只写 `fact-index` 是运行它的全部测试用例；多 runtime 的插件没有用例文件时，这样写会报 `plugin "fact-index" has no tests/runtime-cases.json or covel.test.json`。

## 数据契约与世界导入

世界包可以给插件带数据：一个侦探世界可以带上“开局已知的事实”。做法是插件声明“我的这个数据空间接收哪种数据”，世界包把文件放到约定的位置。

### 声明接收什么

上面的 `PLUGIN.md` 里已经有了：

```yaml
contributes:
  data:
    facts:
      version: 1
      accepts: [facts.index@1]
      schema: ./schemas/facts.schema.json
```

意思是：`facts` 这个数据空间接收名为 `facts.index@1` 的数据，每条记录要符合 `schema`。

- 数据空间接收了某种数据，它的 `schema` 就是这种数据的公开形状，不用在 `contracts` 里再写一遍。
- 只有不被任何数据空间接收的能力（例如某个 runtime 的输出）才需要写 `contracts.<名字>.schema`。
- 几个插件都接收同一种数据时，它们的 schema 必须一致。不一致会在加载或导入之前报错。

### 告诉世界作者怎么写

再加一段 `authoring`，世界作者和创作工具就知道这份内容该放在哪、怎么写：

```yaml
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      accepts: [facts.index@1]
      authoring:
        title: Known facts
        hint: >-
          Write one record for each fact the story starts with. Keep `text` to
          one sentence.
        example: ./examples/facts.json
        source:
          kind: yaml
          path: data/facts.yaml
          key: id
```

| 字段         | 意思                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | 这类内容的名称，给作者看                                                                                                                 |
| `hint`       | 怎样写好这类记录。用简短明确的英文句子                                                                                                   |
| `summary`    | 给玩家看的一句简介。应用内的创作界面用它当选项说明                                                                                       |
| `example`    | 一份合法的示例（JSON）。它会按上面的 `schema` 检查                                                                                       |
| `source`     | 这份内容在世界包里的约定位置：`kind`、`path`、`key`，以及可选的 `visibility: hidden` 和 `lorebook: true`。图片等媒体目录用 `kind: media` |
| `references` | 记录里哪些值写的是世界角色属性的 `id`。`pnpm validate:world` 会在开局前检查它们，写法见 [插件参考](../reference/plugins.md)              |
| `generate`   | 允许应用内的世界生成器只凭 `hint` 和 `example` 生成这份内容，见下文                                                                      |

`title` 是标签，所以清单里写英文，中文写在 `locales/zh.yaml`：

```yaml
PLUGIN.md:
  contributes:
    data:
      facts:
        authoring:
          title: 已知事实
```

世界包把文件放在 `source.path` 写的位置，它就会被导入，不需要再写别的配置。两个插件声明了同一个 `path` 时，这个路径不再算约定位置，所以选一个别的插件不会用的路径。

`generate` 有两个取值：`offer` 把这类内容列为创作界面里的可选项，`default` 列出并默认选中。它要求有 `example`，并且 `source` 是公开的、不是媒体、以 `id` 为 `key`。玩家选中后，生成器会把 schema、提示和示例写进它的提示词，并把这个插件加进世界要启用的插件里。只给在真实模型上验证过生成质量的内容声明它。

### 检查声明

```bash
pnpm describe:authoring --plugins ~/.covel/plugins
```

这条命令把所有插件的 `authoring` 汇总成一份说明。里面会多出你的这一段：

```text
### Known facts — `facts.index@1` (plugin `fact-index`)

How to write it: Write one record for each fact the story starts with. Keep `text` to one sentence.

Put the file at `data/facts.yaml`: it is imported without a descriptor. The same source in a descriptor:

    facts:
      kind: yaml
      path: data/facts.yaml
      schema: contract:facts.index@1
      to: contract:facts.index@1
      key: id
```

世界创作 skill 和应用内的生成器读的是同一份数据。所以新插件声明了 `authoring` 之后，不需要再去改别的文档。

加上 `--check`，它会按 schema 检查每一份示例。全部合格时最后一行是：

```text
Authoring examples match their schemas.
```

### 世界那一边

世界作者按约定位置放文件即可。需要自己指定来源时，在世界的数据描述文件里写 `to: contract:facts.index@1`。Covel 把数据交给当前启用的、声明接收它的插件。世界不会、也不能点名某个插件的数据空间。

想把世界的其他内容换算成自己的数据，用 `contributes.worldProjections`，它的输出必须对应一个可导入的数据空间。完整规则见[世界数据参考](../reference/world-data.md)，字段见[插件清单字段表](../reference/schema/plugin-manifest.md)。

角色卡这类业务格式归对应的插件所有。Covel 只处理通用的“来源 → 目标”和角色本身，不会为某个插件单独包装数据。

## 服务与扩展

两种让别人调用你的代码的方式：

| 方式     | 谁来调用                              | 声明在                   | 注册用                                 |
| -------- | ------------------------------------- | ------------------------ | -------------------------------------- |
| **服务** | 别的插件，在它需要的时候主动调用      | `contributes.services`   | `covel.registerService(...)`           |
| **扩展** | Covel，在固定的时机来问你要内容或策略 | `contributes.extensions` | `covel.provideExtension(point, id, …)` |

- 两者都用带版本号的名字，输入输出都会按 schema 检查。
- 注册的名字必须和清单一致。
- `contributes.prompt` 里的固定片段由 Covel 自动注册，不用再声明成扩展。

每个扩展点的输入、输出、多个提供者怎样合并、出错时怎样处理，见[插件扩展与通信](../reference/plugin-extensions.md)和[扩展点参考](../reference/extension-points.md)。

> [!IMPORTANT]
> 如果现有的扩展点表达不了你的需求，不要去读别的插件的私有数据来绕过。那是它的内部实现，随时会变。

## 后台工作与失败

### 不让玩家等

有三种让 runtime 不挡住回合的写法：

| 写法                                      | 效果                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `schedule.completion: { mode: detached }` | 回合先结束，这个 runtime 在后台继续。只能用在 `post-turn` 和 `audit` 阶段 |
| 再加 `settle: before-next-execution`      | 后台继续，但玩家的下一个行动会等它完成                                    |
| `schedule.manual.execution: background`   | 手动触发的 runtime 放到后台，调用方立刻拿到一个任务编号                   |

由事件触发的 runtime 写 `schedule.trigger: { type: event, topic: ... }`。

不是所有组合都允许放到后台，校验和运行时都会检查。

在后台运行、并且自己调用模型的函数，要声明用的是哪个模型用途：

```yaml
function:
  handler: ./handler.js
  model: memory
```

代码里调用 `ctx.gateway` 时传同一个名字（`presetId: "memory"`）。Covel 用这个声明判断模型的密钥是否就绪，再决定要不要开始这个后台任务。这一行不会替你改代码里的参数，两边要自己写成一样。

插件只能写用途名。用哪个模型、请求发到哪里，由玩家的模型设置决定。在插件目录里放一个 `llm.toml` 不起作用，`pnpm validate:plugin` 会提醒你删掉它。

### 时限

| 类型  | 字段                             | 意思                                            |
| ----- | -------------------------------- | ----------------------------------------------- |
| 函数  | `function.timeoutMs`             | 一次运行的总时限。调用外部接口的时间也算在里面  |
| agent | `agent.loop.timeoutMs`           | 一次运行的总时限                                |
| agent | `agent.loop.callTimeoutMs`       | 单次模型调用的时限（不是流式输出的调用）        |
| agent | `agent.loop.firstTokenTimeoutMs` | 流式调用里，等第一个字的时限                    |
| agent | `agent.loop.idleTimeoutMs`       | 流式调用里，两次输出之间最长的静默。默认 120 秒 |
| agent | `agent.loop.maxRetries`          | 模型调用拿不到回复时重试几次。默认 1，最大 5    |
| agent | `agent.loop.loopDetection`       | 模型连续重复同一个调用多少次算打转。默认 3      |

没有写 `firstTokenTimeoutMs` 时，每次尝试等第一个字的时间会自动缩短，给剩下的重试留出时间。第一个字本来就慢的模型要显式设置它，并把 `timeoutMs` 调大。完整的规则见[插件字段参考](../reference/plugins.md)。

### 失败时

- 运行失败的 runtime，它的写入一条都不保存，它发的事件也不会触发别的 runtime。
- 所以只把合法的结果交回去。不要“先写一半，出错再补”。
- 同一个操作可能被重试。让重复执行得到同样的结果：用稳定的键写数据，而不是每次生成新的键。
- 长时间的工作要响应 `ctx.signal`：玩家取消时尽快停下。

### 不是工具的能力

函数里有几样东西是直接调用的，不经过工具清单和授权流程：`ctx.gateway`（调用模型）、`ctx.images` / `ctx.speech` / `ctx.music`（生成媒体）、`ctx.media`（保存媒体）、`ctx.utils`（网络请求）。

生成图片时，在函数里直接调用 `ctx.images.generate(...)`。不要做一个让模型调用的“生成图片”工具，也不要自己写请求去调用图片服务商。细节见[图片生成](../reference/image-generation.md)和[媒体存储](../reference/media-store.md)。

## 权限

### 访问外部接口

要访问外部接口的 runtime，先声明它会访问哪些地址：

```yaml
permissions:
  http:
    - origin: https://api.example.com
      methods: [GET]
```

- `origin` 只能是 `https` 地址，不带路径、参数和账号密码。
- `methods` 可选，取 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`HEAD`。
- 请求用 `ctx.utils.fetchWithRetry` 发出。社区插件访问没有声明的地址会被拒绝。
- 不要把玩家输入的任意网址直接交给后端去抓取。先用 `ctx.utils.validateBaseUrl` 检查。

> [!WARNING]
> 声明权限不等于得到权限。社区插件的代码要玩家授权之后才会运行，授权、限额和网址检查都由 Covel 执行。边界和原因见[安全边界](../internals/security.md)。

### 说明读写什么

`effects` 说明这个 runtime 读什么、写什么：

```yaml
effects:
  reads: ["plugin-data:self:facts"]
  writes: ["plugin-data:self:facts", "http:https://api.example.com"]
```

可以写的值：

| 写法                                                                                                   | 意思               |
| ------------------------------------------------------------------------------------------------------ | ------------------ |
| `plugin-data:self:<数据空间>`                                                                          | 自己的某个数据空间 |
| `event:<事件名>`                                                                                       | 某个事件           |
| `http:https://<主机>`                                                                                  | 某个外部地址       |
| `state:*`、`narrative:*`、`characters:*`、`lorebook:*`、`assets:*`、`media:*`、`ui:*`、`interaction:*` | 对应的一类共用资源 |

`parallelSafe: true` 表示它可以和同一阶段的其他 runtime 同时运行。会改动共用数据或访问外部接口的 runtime 都应该声明 `permissions` 和 `effects`。

## Hook

Hook 让你在固定的时刻插一脚：工具调用之前、模型调用之前、回合开始时，等等。它只用来**拦截、改写或记录**，不要把玩法写在里面。

在 `PLUGIN.md` 里列出要监听的时刻：

```yaml
contributes:
  hooks:
    - event: PreToolUse
```

在入口文件里注册。两边必须一致：

```js
export default function register(covel) {
  covel.on("PreToolUse", async (ctx, payload) => {
    if (ctx.runtimeId !== "fact-index/extract") return { action: "continue" };
    if (payload.toolCall.name !== "plugin-data-delete") {
      return { action: "continue" };
    }
    return { action: "abort", reason: "This runtime may not delete facts." };
  });
}
```

- 这件事说的是哪个 runtime，从 `ctx.pluginId` 和 `ctx.runtimeId` 读。`payload` 里没有它们：读 `payload.runtimeId` 永远对不上，这个 hook 就什么都不做。
- `ctx.locale` 是这一局游戏的语言。往提示词里加文字时，用 `instructionLocaleFor(ctx.locale)` 决定用哪种语言，不要从提示词的文字去猜。
- `ctx.getOwnSettings()` 读这个插件自己的设置。

有哪些时刻、每个时刻带什么数据、可以返回什么，见 [Hook 参考](../reference/hooks.md)。

## 世界模型与记忆

- `ctx.world` 给出的是“这次运行看到的世界”：已保存的状态，加上这一回合里前面的步骤提出、但还没保存的合法修改。
- 改角色、改角色的字段定义，都走同一套检查。
- 不要把前面步骤的写入请求复制进自己的结果里再提交一遍。
- 记忆块是 memory 插件的数据和服务。世界自定义的记忆块通过 `memory.blocks@1` 导入，默认的定义由 `memory.block-definitions@1` 服务提供。历史压缩通过 `history.compact@2` 扩展点处理。清单里没有 `memoryBlocks`、`summaryFocus` 这样的字段。

细节见[世界模型参考](../reference/world-model.md)。

## 本地化与热重载

- 提示词的中文版是包根目录的 `PLUGIN.zh.md` 和每个 runtime 的 `RUNTIME.zh.md`。别的语言的同类文件不会被读取。
- 中文版可以只写要翻译的部分，没写的沿用英文版。
- 中文版改了不该改的东西（片段的 ID、位置、输入、工具、时限）时，校验会报告，运行时仍然用英文版的值。
- 提示词在插件加载时读入，运行期间不再读磁盘。热重载之后，新开始的运行用新内容，已经开始的运行继续用它开始时的内容。所以不要在代码里自己重新读清单。

## 发布之前

### 填写发布字段

在 `PLUGIN.md` 里加上：

```yaml
version: 0.1.0
covel: ">=0.0.51"
author:
  name: Jane Doe
  url: https://example.com
  about: I write small mystery worlds.
license: MIT
homepage: https://example.com/fact-index
```

| 字段       | 意思                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `version`  | 插件的版本。必须和 `package.json` 里的 `version` 相同，校验会检查                                                  |
| `covel`    | 适用的 Covel 版本范围。范围之外的 Covel 不安装也不加载它。写法见[合集 · 版本范围](../ship/collections.md#版本范围) |
| `author`   | 作者名、主页、一段写给玩家的话、几个链接。链接只能是 `https`                                                       |
| `license`  | 许可证                                                                                                             |
| `homepage` | 插件自己的页面                                                                                                     |

字段的长度限制和显示位置见[作者信息](../reference/plugins.md#作者信息)。

> [!WARNING]
> `version` 变了之后，已有的游戏会重新运行这个插件的开局 runtime（`setup` 阶段）。开局 runtime 的 guard 必须检查“这件事是不是已经做过”，做过就返回 `{ skip: true }`。

### 写 README

写清楚这几件事：玩家能看到什么、输入和输出的能力、设置项、需要的权限、有哪些 runtime、怎样测试。

### 检查包里的东西

- `package.json` 里 `"type": "module"`。
- 用户目录里的插件必须自己能运行，不依赖 `npm install`。
- 不要带上密钥、生成的数据和你电脑上的路径。

### 最后跑一遍

```bash
pnpm validate:plugin ~/.covel/plugins/fact-index
pnpm test:runtime -- fact-index --pretty
```

第二条命令运行 `tests/runtime-cases.json` 里的全部用例，所以发布前至少给每个 runtime 写一个。

仓库内置的插件再加上自己的单元测试和全仓检查：

```bash
pnpm --filter @covel/plugin-fact-index test
pnpm check
```

测试要覆盖的重点：数据形状的边界、不能读写别人的数据、重复调用、失败之后没有留下半截数据、同一次运行里先写后读。写法见[插件测试](./testing.md)。打包和安装见[打包并试装](../ship/package.md)。

## 没有按预期工作时

| 现象                                                         | 原因和处理                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 校验报 `inline runtime and runtimes/ cannot coexist`         | `PLUGIN.md` 里还留着 `runtime:`。多 runtime 的包里删掉它                          |
| 校验报 `contributes.hooks.0: Invalid input: expected object` | hook 要写成 `- event: PreToolUse`，不是一个字符串                                 |
| 校验报 `output contract … is not declared in root provides`  | 把这项能力加进 `PLUGIN.md` 的 `provides`                                          |
| 世界包的数据没有导入                                         | 文件不在 `source.path` 的位置，或者别的插件声明了同一个路径，或者这个插件没有启用 |
| `describe:authoring --check` 报示例不合格                    | `example` 文件不符合 `schema`                                                     |
| 后台 runtime 一直排队                                        | 它调用了模型，却没有声明 `function.model`                                         |
| 请求外部接口被拒绝                                           | 地址没有写进 `permissions.http`，或者不是 `https`                                 |
| hook 注册了却从不生效                                        | 在 `payload` 里找 runtime 的名字。改成读 `ctx.runtimeId`                          |
| 升级版本后开局步骤又跑了一遍                                 | 正常。让开局 runtime 的 guard 对已完成的工作返回 `{ skip: true }`                 |

## 接下来

- [插件测试](./testing.md)
- [打包并试装](../ship/package.md)、[发布与更新](../ship/publish.md)
- 把插件和世界一起发布：[合集](../ship/collections.md)
- 全部字段：[插件字段参考](../reference/plugins.md)
