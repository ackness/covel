# 插件扩展边界与通信

一个插件很少单独工作：它要读别的插件算出的结果、发事件、调用别人的函数、在界面上画自己的面板。本页说明这些事各用哪个接口、每个接口的边界在哪里。写多个插件互相配合、接新的模型协议、或做自绘界面的作者需要它。

分工是这样的：框架负责发现、授权、调度、校验、取消和挂载。业务数据的结构、算法、服务商协议和界面组件都留在插件包里。

可以装上直接看的示例：

- [Lifecycle Probe](../../tests/third-party/lifecycle-probe/README.md) 和 [Service Provider Probe](../../tests/third-party/service-provider-probe/README.md)：两个可以独立安装的插件，一起覆盖命令、面板、手动函数、数据提交和服务协作。
- [Jev 选项推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo)。

## 选择通信方式

先按需求在表里找接口：

| 需求                             | 接口                                                             | 执行与数据边界                                                             |
| -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 消费本轮上游结果                 | `runtime.io.inputs` + `accepts`                                  | 按版本化 contract/runtime 绑定，建立调度依赖，携带来源；必需输入缺失时跳过 |
| 消费已提交的历史结果             | `runtime.io.output.recordAs` + `io.inputs` 的 `scope: committed` | 读取本次执行开始前的快照                                                   |
| 发出事件、触发后续工作           | handler 结果的 events / `emit-event` 工具 + event trigger        | 由调度和提交链路管理；不是内存中任意广播                                   |
| 调用其他插件的公共函数或模型协议 | `covel.registerService` + `ctx.services`                         | 请求/响应，校验输入输出，只调用活跃且已获准运行的服务                      |
| Runtime 执行领域写入             | 已声明工具、handler effects / `ctx.pluginData`                   | 走 runtime 的 proposal/commit 边界，不直接写别的插件                       |
| UI 触发自己的服务端逻辑          | `invokeRuntime` / `invokePluginAction` / `invokeCommand`         | 复用现有 RPC、会话归属与审批；写入边界见下文                               |
| UI 发出领域事件                  | `emitEvent`                                                      | 只能发本插件声明的 topic，按 schema 校验；订阅的 runtime 以事件任务执行    |
| 自由绘制 UI                      | JSON `view` 或 HTML `webview`                                    | HTML 在独立 sandbox 中运行，使用消息桥读取数据、发出动作                   |

下面是表里装不下的细节。

函数 runtime 改自己的数据时，可以交一串操作而不是算好的整个值：`ctx.pluginData.update(namespace, key, ops)` 产生 `plugin.data.update`，提交时在最新的值上应用（见[事务 · 操作式写入](./transactions.md#操作式写入plugindataupdate)）。这只属于 runtime 的写入边界：扩展点 handler 的 `ctx.pluginData` 只读，服务 handler 根本拿不到 `ctx.pluginData`。

`ctx.recursiveCall` 的用途是[包内嵌套调用](./plugins.md#嵌套调用ctxrecursivecall)。要请求其他包的结果，使用服务；要触发其他包的后续工作，使用事件。

### 服务只给函数 runtime

`ctx.services` 目前只向函数 runtime 开放。框架不会把所有公共服务自动暴露给每个 agent。agent 想用服务的结果，有两条路：

- 让插件自己的一个函数 runtime 去调用服务，agent 再通过 `inputs` 接收结果。
- 继续用插件自己注册的工具。

### 事件怎么触发下游

runtime 发出的事件在同一回合的事件链里逐层匹配订阅者。

- 每一层里匹配到的 runtime，按它们声明的 `needs` / `after` / `inputs` 关系排序执行。上一层的结果对下一层立即可见。
- 没匹配到的提供者不会被额外触发。
- 后台 follower，以及界面发出的事件所触发的任务，是各自独立的持久任务。同一回合内的排序不管它们：不保证它们之间的先后，也不拿一个的成功作为另一个的前提。

`needs` 指向一个只需要单个提供者的契约时，前一个阶段或前一层事件里已经满足的结果可以算数。即使当前这一批里的另一个提供者形成了循环依赖，已经满足需求的消费者仍然可以运行。`after`、需要全部提供者的需求、输入绑定，各自的排序约束不变。

### 界面触发的写入：三个动作的区别

| 动作                 | 做什么                                         | 写入                                                                               |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `invokePluginAction` | 调用插件的 RPC action                          | 立即生效。handler 后面失败了，前面的写入不会自动撤回。                             |
| `invokeRuntime`      | 触发一个 `trigger.type: manual` 的函数 runtime | `ctx.pluginData` 写入和领域 effects 进入同一次 proposal 提交，一起成功或一起失败。 |
| `invokeCommand`      | 执行清单里声明的玩家命令                       | 走命令的校验与审计。不要用 `invokePluginAction` 绕开它。                           |

多条记录必须一起成功或一起失败时，用 `invokeRuntime`。这个函数 handler 不需要模型。手动触发本身不会运行叙事 runtime；它声明的事件下游仍按调度规则执行。

RPC action 的 handler 收到 `ctx.signal`，到达时限时中止；存储调用的关闭与已开始写入的结算见下方 RPC 通道。

参见 [RPC 通道](./api.md#post-apisessionsidplugin-rpc)与 [handler 写入契约](./plugins.md#输入和输出)。

### 工具不跨插件

插件工具在 `entry` 里用 `covel.registerTool()` 注册，名字在插件内唯一。不同插件用同一个名字不会互相覆盖。一次工具调用只会找到调用方插件自己的实现和框架内置工具。要给别的插件用的能力，做成下文的服务。

### 没有 runtime 的包

只有 `entry`、Hook 或 UI 的包可以没有 runtime。

- 它的 Hook 仍然按会话里启用的插件集合运行。
- `ctx.getOwnSettings()` 读到包级 `userSettings` 的默认值，加上这个世界和玩家的覆盖值。没有 runtime 不会丢掉这些默认值，也不会凭空多出一个 runtime 被调度。

把内核嵌进自己宿主的开发者还要知道：执行和提交各用一个明确的会话 Hook scope。直接调用 `executeTurn` 的宿主如果要包含没有 runtime 的包，在 `TurnExecutorDeps.hookScope` 里传入它的 `activePluginIds` 和解析好的 `settings`。执行入口会记下并冻结这个范围，随后随 `execution` 自动传给 `commitExecution`。Covel 的服务端从持久化的会话激活集合构造这个 scope。社区插件的 Hook 每次调用时仍检查当前的 server-code 授权。

### Hook

每个 Hook 事件什么时候触发、负载是什么、可以返回什么、handler 收到什么上下文，见 [Hooks](./hooks.md)。和通信有关的几条：

- `contributes.hooks` 按 `event` 和 `enforce` 声明允许的 Hook。省略 `enforce` 等于 `normal`。
- 一条声明可以多次调用 `covel.on()` 注册多个独立的 handler。
- 注册了没声明的事件或分组，或声明了却没有实现，都会让整个 entry 发布失败。
- 同一事件的 handler 按分组依次执行：`pre` → `normal` → `post`。组内先执行框架的 Hook，再按注册顺序执行插件的 Hook。不同插件之间的先后取决于加载顺序，不是可以声明的约定。
- 两个插件改写同一份负载时，后执行的 `replace` 覆盖先执行的同名字段。需要确定先后的插件应声明不同的 `enforce`。
- `TurnStop` 在一次执行的全部 runtime 结束之后、提交之前触发。这时写入还没有落库，也可能在提交时被拒绝。要在数据落库之后做事，用 `PostStateCommit`。

## 插件作者类型

外部插件从公开包 `@covel/plugin-handlers-utils` 导入 `PluginAPI` 或 `PluginEntryFactory` 类型，不需要安装私有的 runtime / shared 包。

| 入口                                            | 提供什么                          |
| ----------------------------------------------- | --------------------------------- |
| `@covel/plugin-handlers-utils`                  | `PluginAPI`、`PluginEntryFactory` |
| `@covel/plugin-handlers-utils/extension-points` | 扩展点的输入、输出和上下文类型    |
| `@covel/plugin-handlers-utils/plugin-api`       | 完整的入口类型                    |

```js
/** @type {import("@covel/plugin-handlers-utils").PluginEntryFactory} */
export default function (covel) {
  covel.provideExtension("prompt.segment@1", "direction", {
    handler: (_input, ctx) => [
      {
        id: "direction",
        content: `Locale: ${ctx.locale}`,
        position: "system",
        audience: "self",
        volatility: "turn",
      },
    ],
  });
}
```

用 TypeScript，或给 JavaScript 打开 `checkJs` 之后，已知的扩展点会约束 handler 的输入和输出。类型检查代替不了别的检查：清单声明和运行时的 schema 校验仍然必需，授权和输出校验照常进行。

SDK 还导出 `estimateTokens`、`FRAMEWORK_TOOL_NAMES`、多语言文本和表单的辅助函数等，完整的表见[公开 SDK 里的辅助函数](./extension-points.md#公开-sdk-里的辅助函数)。

> [!IMPORTANT]
> 插件 JavaScript 模块里的相对导入必须指向包里真实存在的文件。导入一个没编译的 TypeScript 文件时，要写真实的 `.ts` 后缀。
>
> 在仓库里开发时，`pnpm dev` 用 tsx 加载器启动，它会处理这类导入。Node 自带的类型剥离不会把 `.js` 导入对应到 `.ts` 文件，所以直接用 `node` 的 `import(...)` 加载整个源码依赖图是行不通的。

## Entry 资源生命周期

`entry` 工厂里可以打开连接、起计时器、建缓存。这一节说明这些资源什么时候该关、怎么关。

- `covel.signal` 代表这一次插件激活。初始化失败或宿主关闭时，它被取消。
- `covel.onDispose(callback)` 在工厂执行期间登记清理函数，同步或异步都可以。用它关闭订阅、连接、计时器和共享缓存。
- 拿到一个资源后**立刻**登记它的清理，再做下一步可能失败的初始化。

```js
export default function (covel) {
  const cache = new Map();
  const timer = setInterval(() => cache.clear(), 60_000);
  covel.onDispose(() => {
    clearInterval(timer);
    cache.clear();
  });
  // Pass covel.signal to asynchronous initialization and shared resource work.
  // Register services, tools or RPC handlers here.
}
```

### 关闭的顺序

1. 取消信号，停止接收新的注册。
2. 撤销已经发布的能力。
3. 按登记的相反顺序等待清理函数。

一个清理函数失败不会阻止其他清理，错误会汇总报告。重复关闭不会再次执行回调。初始化失败时同样清理已经拿到的资源，重试会用一个新的 signal。测试运行器在执行完成或失败后也会关闭入口资源。

### 时间上限

| 事情                     | 默认上限 |
| ------------------------ | -------- |
| 服务端 entry 初始化      | 15 秒    |
| 初始化失败后的回滚清理   | 15 秒    |
| 失败后被动服务发现的退避 | 30 秒    |

清理超时不会阻止失败结果返回、后续重试，或其他会话取得快照。宿主关闭时仍会报告没完成的失败清理。显式激活和重载不受退避限制，可以马上重试。

### 并发

首次激活和重载的准备工作，对同一个插件是排队进行的。工厂运行、runtime 模块加载、失败后的资源清理都不占用全局发布队列：别的插件，以及不依赖这个插件的会话，可以继续执行。

一次执行在取得 runtime 的过程中如果有新一版发布，宿主会重新取快照。这保证同一次执行用到的工具、服务和 runtime 来自同一版。

### entry 不属于某个会话

> [!WARNING]
> entry 在宿主里每个插件只激活一次，所有会话共用它。不要把会话数据放在模块顶层变量或闭包里。

- 在一个会话里禁用插件，不会销毁其他会话共用的 entry。
- 会话数据用调用上下文和插件数据存储。
- 单次任务的取消用 `ctx.signal`。需要知道会话结束时，用 `SessionEnd` Hook。
- 这套机制靠插件自己配合取消和清理。它不能强行终止一段不理会信号的 JavaScript，也不提供独立的后台调度器。

### 宿主怎么报告状态

宿主目录里的 `hostState` 只描述 entry 实际的发布状态：`discovered` / `installed` / `loaded` / `error`。它不包含“已批准”。

授权和启用是每个会话各自的事，由会话 API 单独给出：实时的 `serverCodeApproved`，以及依赖解析之后的 `sessionState` / `autoAdded` / `rejection`。不能从全局的 `loaded` 推断另一个会话有没有授权。

首次激活失败时显示 `error`。重载失败但旧版本还保留着时，仍显示 `loaded`，错误信息另外展示。

## 开发时单插件热重载

改了社区插件的文件，不用重启服务就能生效。这只在 `NODE_ENV=development` 下可用；内置插件和生产环境不允许。

### 触发方式

- 手动：`POST /api/plugins/:id/reload`，请求体可选 `{ "sessionId": "..." }`。
- 自动：开发宿主监听社区插件目录，把 150 毫秒内的文件变化合并成一次，走同一条重载路径。 用 `pnpm dev` 启动时有一个例外：它的监视器（`tsx watch`）也盯着服务已经加载过的每个代码文件，所以改这样的文件（跑过的 `handler.js`、entry，以及它们导入的模块）会让整个后端重启，而不是走这里的重载；重启后社区插件要重新授权。清单、界面文件和译文不受影响，仍然走这里的重载。

两种方式的条件相同：

- 操作要通过安装 API 的本机或管理员鉴权。
- 要有一个会话提供当前有效的 server-code 授权。请求里指定了会话就用它；没指定时用曾经批准过这个插件的会话。
- 没有有效授权时，拒绝执行插件代码。

### 一次重载做了什么

1. 解析新的声明，运行新的 entry 工厂，校验注册和声明一致。
2. 预加载 handler 和 guard（只加载同时拿到 server-code 和 runtime 两种授权的）。
3. 一次性发布工具、Hook、RPC、服务、表单校验器、wire 和 runtime 元数据。

准备失败时保留旧版本。

正在进行的执行继续用旧版本，之后的执行用新版本。旧版本不再接受新的查找；等到用着它的执行都结束、超时后仍未结束的 provider promise 也释放之后，才调用它的 `onDispose()`。快照不保存授权：调用和提交时仍检查授权有没有被撤销。

### 重载之后的会话

新版本发布后，每个会话的下一次执行会先重新解析依赖关系，再取新快照。解析用的是玩家原来的请求、明确排除的插件和当前的授权。

- 新增了必需的契约却没有提供者，或出现互斥冲突时，这个插件不能沿用旧的激活结果继续执行。修正声明之后，玩家原来的选择仍然保留。
- 已经开始的执行保留原来的激活关系和服务引用。但显式停用、撤销授权或替换会话仍会让它失效。

### 事件 schema

事件 schema 在启动时和新版本准备期间读取并编译。编译结果和编译失败都按版本缓存，然后才发布新声明。同一路径的文件修正要到下一次重载才生效。已经被取用的旧版本即使还没处理过这个事件，也保持原来的校验器，不受磁盘上后续编辑的影响。

### 启动时就解析失败的插件

启动时静态解析失败的社区插件也保留它的发现位置，并接受文件监听。

- 重载只沿用这个包的 ID、根目录和发现来源。它按当前文件重新检查布局，不继承旧的 `layoutError`。补上根 `PLUGIN.md`，或改对子清单的文件名之后，可以恢复。
- 新一次扫描仍有错误时，不发布新声明，也不清除失败的发现位置。
- 修正文件后，如果这个插件从未发布过任何能力，宿主可以在没有 server-code 授权的情况下重新校验并发布它的**静态声明**。这不会导入 entry、handler 或 guard；首次激活仍然要走正常审批。
- 已经有活动版本的插件不能走这条恢复路径。
- 监听的目录消失了只记一条警告，不中断宿主启动。

### 哪些改动重载不了

> [!NOTE]
> 每次重载都会重新导入 entry、handler 和 guard，以及它们用相对路径导入的、位于插件目录内的 ES 模块。所以只改 `lib/helper.js` 这样的依赖模块并保存，新代码也会生效。

- 同一次重载里，entry、handler 和 guard 共用同一份新的依赖模块；上一版继续用它自己的那一份。依赖模块顶层的状态因此不会带到新版本，需要保留的数据应写入插件数据。
- 这些不会重新加载：插件目录以外的文件、`node_modules` 里的包（包括 `@covel/plugin-handlers-utils`）、CommonJS 文件（`.cjs`）和原生模块（`.node`）。改了它们、宿主代码，或不能安全清理的顶层资源，要重启服务。
- Node 不会释放已经加载的模块。每次重载都会在内存里多留一份这个插件的模块，只有重启服务才能回收；长时间反复重载之后，可以重启一次。

## 公共函数注册与调用

一个插件可以把一个函数公开给别的插件调用，这叫**服务**。

### 注册

服务在 `entry` 工厂运行期间注册。它和工具、Hook、RPC 一起发布：全部成功才生效，失败就全部撤回。宿主关闭时解除注册。

- 服务名在所属插件内唯一。
- `contract` 是插件作者定义的公开契约标识，建议带上版本号。
- 不兼容的修改用一个新的契约，不为开发数据写迁移。

```js
export default function (covel) {
  const { z } = covel.toolkit;
  covel.registerService({
    name: "rank",
    contract: "my-plugin/rank@1",
    input: z.object({ candidates: z.array(z.string()).min(1) }),
    output: z.object({ selected: z.string() }),
    async handler(input, ctx) {
      ctx.signal.throwIfAborted();
      return { selected: input.candidates[0] };
    },
  });
}
```

### 发现和调用

别的插件先用 `ctx.services.discover("my-plugin/rank@1")` 找到提供者，得到 `{ pluginId, name, contract, description? }[]`，再明确选一个来调用。

有多个提供者时，由调用方插件的设置或业务规则决定用哪个。框架不按插件名字猜，也不自动选第一个。

```js
const value = await ctx.services.call({
  pluginId: configuredProviderId,
  name: "rank",
  contract: "my-plugin/rank@1",
  input: { candidates: ["Visit the library", "Explore the classroom"] },
});
```

可以给一次调用设一个比 runtime 更短的时间上限，或单独取消它：

```js
const value = await ctx.services.call(
  {
    pluginId: configuredProviderId,
    name: "rank",
    contract: "my-plugin/rank@1",
    input: { candidates: ["Visit the library", "Explore the classroom"] },
  },
  { timeoutMs: 1500, signal: ctx.signal },
);
```

### 超时和取消

- `timeoutMs` 是正的有限毫秒数，最大 `2147483647`。它包含排队等待准入的时间和实际执行的时间。
- 超时抛出 `name: "TimeoutError"` 的异常。单独取消时保留取消原因。
- 父 runtime 被取消时，服务调用也被取消。反过来不成立：一次调用超时或被取消不会取消父 runtime。调用方可以捕获错误，改用备用提供者。
- 服务里再调用的服务、gateway 和 HTTP 请求继承这次调用的信号。
- 调用一结束，它的上下文就关闭。不能把上下文存起来，等返回之后继续用它发起工作。
- 不配合取消的异步代码可能继续跑，但调用方会及时结束等待。迟到的结果不会被当作成功结果返回。

### 调用前的检查

每次调用前，框架重新检查：调用方和提供方是否仍然启用，社区插件的服务端代码是否获准运行。

- 发现接口不会激活未获准运行的社区代码。
- 一个服务在进程里注册了，不代表当前会话可以调用它。

### 服务能拿到什么，不能拿到什么

- 输入和输出按 schema 校验，并被复制一份。不能靠对象引用去改对方的状态。
- 上下文只有 `callerPluginId`、`signal`、`gateway`、`utils`、`services`。没有调用方的 store、工具、设置或写入缓冲。
- 服务只负责算出结果。怎么把结果写进存储，由发起调用的 runtime 决定。
- 服务调用链不允许循环，最多八层。它继承 runtime 的截止时间和能力撤销。
- 服务必须把 `signal` 传给异步工作，不能把任务留在脱离调用的后台。
- 服务端的普通 JavaScript 仍遵循社区代码的授权模型。这不是进程级沙箱。

## 模型与新协议

插件需要调用模型，或接入一家新的服务商时，按下面的情况选做法。

### 用已有的模型能力

- 文本、图片、语音、音乐：用 `ctx.gateway`、`ctx.images`、`ctx.speech`、`ctx.music`。它们的类型（`PluginServiceGateway`、`PluginImages`、`PluginSpeech`、`PluginMusic`、`PluginMedia`）由 `@covel/plugin-handlers-utils` 导出，宿主实现的就是这些类型。
- 评估：`ctx.gateway.evaluate({ presetId, state, questions, signal })`，支持 Boolean、Choice、Score 三种问题。

### 自己拼长提示词时的预算

- `ctx.gateway.resolveSlot({ presetId })?.limits` 给出 gateway 对这个 slot 实际采用的 `{ contextWindow, maxOutputTokens }`。模型没有声明上下文窗口时，这个字段省略；框架不会把自己的兜底值当成真实上限给你。
- `generateText` / `generateObject` 可以传 `maxOutputTokens` 作为单次调用的上限。它只能低于玩家为这个 slot 配的输出预算，不能调高。

### 要 JSON 回复

给 `generateText` 传 `responseFormat: { type: "json_schema", schema }`。支持 JSON 模式的协议会打开它，schema 同时作为指令加进消息。

返回的 `text` 仍然是文本，插件自己解析并检查内容对不对。回复读不出来时，用 `ctx.logger.warn` 留一段有长度上限的摘录：trace 不保存回复正文。

### 日志

| 方法             | 写到哪里                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `warn` / `error` | 本会话的 `_logs` 环，另外在服务器日志里写一行 `[plugin-log] <runtimeId>: <message> <meta>`（`meta` 截到 2000 字符）。 |
| `debug` / `info` | 只进 `_logs`。                                                                                                        |

这样运维不用翻会话数据就能看到警告和错误。

### 新的服务商、新的协议

| 情况                                         | 做法                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新服务商，用的是已有的 wire                  | 只配置 provider、base URL、模型和用途。不用改插件或框架。                                                                                                                                    |
| 新 wire，或新的返回形式                      | 在一个服务内部用 `ctx.gateway.resolveSlot` 取得本次请求的模型配置，再用 `ctx.utils.validateBaseUrl` / `fetchWithRetry` 实现协议，定义自己的输入输出 schema。结果通过服务契约提供给其他插件。 |
| 图片、语音、转写、音乐，想复用统一的媒体管线 | 用 `covel.registerWires`。媒体落库仍通过现有的媒体接口。                                                                                                                                     |
| 新的文本协议（内置四种之外的请求和响应格式） | 也用 `covel.registerWires` 注册，见下文[文本协议 wire](#文本协议-wire)。注册后它和内置协议一样，任何文本用途都可以选用，主叙事也可以。                                                       |

密钥只留在服务端，不写进结果、日志或界面。

### 音乐生成

```text
ctx.music.generate({ prompt, lyrics?, instrumental?, durationSeconds?, format?, presetId?, metadata?, signal? })
  → { refs, warnings, cached }
```

- 去重和落库的约定与 `ctx.speech.generate` 相同。
- `ctx.music.isAvailable(presetId?)` 只检查有没有配置音乐用途，不向服务商发请求。
- 内核不带音乐 wire。提供音乐模型接入的插件用 `covel.registerWires({ music: [{ id, compose }] })` 注册。`compose(config, params, context)` 返回 `{ audio: { mimeType, data }, usage, warnings }`。需要轮询的服务商，在 `compose` 里轮询完再返回。

> [!WARNING]
> 一首曲子要生成几十秒到几分钟。只在 detached 或后台 runtime 里调用它，不要放进回合。

### 权限不会因为跨插件而变大

服务里的 gateway 继承发起调用的 runtime 的请求配置、追踪、取消和撤销边界。HTTP 请求由提供方的代码发出，所以按提供方的声明检查：社区提供方处理函数里的 `context.utils` 和它的 `covel.http` 一样，只能访问它自己包的 `permissions.http` 列出的源，不管调用方是谁。扩展的处理函数也是这样。gateway 已经有标准方法的能力，优先走 gateway。

### “不用改框架”的范围

它指插件能用自己的契约实现功能。如果希望框架的通用模型设置、调度器或媒体系统直接认识一种全新的能力类型（文本、图像、语音、转写、音乐、评估之外的），那仍然要改宿主的公共契约。注册一个服务不会自动给这份能力清单添加新成员。

### 文本协议 wire

```js
export default function register(covel) {
  covel.registerWires({
    text: [
      {
        id: "converse",
        label: "Acme Converse",
        async generateText(config, params, context) {
          const response = await covel.http.fetchWithRetry(
            `${config.baseUrl}/converse`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${config.apiKey}` },
              body: JSON.stringify(toAcmeRequest(params)),
              signal: config.signal,
            },
          );
          const body = await response.json();
          return {
            text: body.output,
            finishReason: body.stopReason,
            usage: { inputTokens: body.in, outputTokens: body.out },
          };
        },
        async *streamText(config, params, context) {
          // yield { type: "text-delta", textDelta } … then one final
          // { type: "done", finishReason, usage }
        },
      },
    ],
  });
}
```

声明和命名：

- 和图片、语音等 wire 一样，文本 wire 的 `id` 要写进清单的 `contributes.wires`（上例为 `wires: [converse]`）。注册了没声明，或声明了没注册，插件都加载失败。
- 注册名是 `<pluginId>/<wireId>`（上例为 `acme/converse`）。模型的 `protocol` 写这个名字即可，`llm.toml` 和设置页都认。
- 设置页的协议下拉通过 `GET /api/ai/protocols` 列出已加载插件注册的协议，显示的名称取 `label`。

要实现什么：

- 必须实现 `generateText` 和 `streamText`。类型见 `@covel/plugin-handlers-utils` 的 `PluginTextWire`。
- `params` 带 `model`、`messages`（含工具调用与工具结果）、`tools`、`responseFormat` 和 `providerRequestMetadata`。
- 消息文字和 text 块不含内部缓存断点标记。`instructionLocale` 是宿主按会话选出的指令语言（`en` 或 `zh`），结构化输出的补充指令也使用它。
- 流的最后一个事件必须是 `done`。
- `finishReason` 可以直接返回服务商自己的词，网关会统一成 `stop` / `length` / `tool_calls` 等（见 [slots.md](./slots.md#连接测试与失败原因) 的结束原因说明）。
- 结构化输出不用单独实现：网关把 JSON Schema 放进 `responseFormat` 并作为指令加入消息，调用 `generateText`，再解析和校验结果。
- embedding 不走文本 wire。
- 可选的 `listModels(config, signal)` 返回端点提供的模型 ID。设置页的“从服务读取模型列表”会用它。

请求和密钥：

- wire 自己发 HTTP。所以这些请求不出现在 provider 请求追踪里，框架的传输重试和请求预算也不作用于它。
- `config.signal` 在调用被取消或超时时触发，要把它传给请求。
- `config` 里有该用途解析出的地址和密钥。它们只能用于向该地址发请求，不得写入结果、日志或界面。
- 模型的 `protocol` 指向的插件没有加载，或没有在当前会话启用时，调用以配置错误失败，错误里写明要启用哪个插件。它不会改用别的协议。

哪些请求可以选用这个协议：

| 请求                                                     | 条件                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 会话里的请求                                             | 该插件在这个会话里处于启用状态（社区插件的启用已含玩家授权）。           |
| 不属于任何会话的请求（连接测试、读取模型列表、生成世界） | 可以选用内置插件的协议。                                                 |
| 同上，`self` 形态                                        | 只有一个玩家，已加载的社区插件都经他授权，所以也可以选用社区插件的协议。 |
| 同上，托管形态                                           | 社区插件的协议要在已启用它的会话里使用。                                 |

请求级预设、`llm.toml` 的槽位和 runtime 自己的槽位偏好都按这张表判断。设置页的协议下拉仍列出所有已加载插件的协议。插件注册的图像、语音、转写和音乐 wire 也按这张表选用；选不到时，生成以配置错误失败，错误里写明要启用哪个插件。

> [!CAUTION]
> 信任边界和媒体 wire 相同：社区插件的服务端代码要玩家授权后才运行。wire 里的 `covel.http` 只能访问包里 `permissions.http` 声明的源，以及它正在服务的那个用途的端点。不同的是，文本 wire 会经手选用它的那个用途的**全部提示词和回答**。

## 自定义组件与挂载

插件在 `ui.right` 声明一个 JSON 外壳。里面用 `view`（JSON 描述的界面）或 `webview`（一个 HTML 文件），二选一。业务界面不必都用框架自带的组件。

```json
{
  "id": "my-widget",
  "label": "My widget",
  "surfaces": ["panel", "stage"],
  "dataSource": { "namespace": "results" },
  "webview": { "entry": "./widget.html", "height": 280 }
}
```

### 面板出现在哪里

- `surfaces` 缺省为 `panel`，即右侧面板。
- 声明 `stage` 后，面板也挂在舞台的决策区域。这个位置同样支持 JSON `view`。
- 右侧面板里每个插件面板都带一个“放大”按钮，把同一个面板移到大对话框里显示。同一时刻只有一个实例；`webview` 在那里占大约 72vh 的高度，不受 `height` 限制。这是宿主的行为，spec 不用声明。

宿主只提供已有的挂载位置，不关心面板的业务：它不知道面板是推荐、骰子还是地图。要新增一个产品级的全局位置，仍然需要宿主来提供。

### HTML 文件的要求

- `webview.entry` 相对于这个 JSON 文件，必须是插件根目录内的 `.html`。真实路径（包括符号链接指向的位置）不能越出插件目录。
- 单个文件最多 512 KiB。
- 可以用原生 DOM、Canvas、SVG，或把 React / Vue 等构建成一个包含脚本和样式的单个 HTML。
- 不用改 Web 源码，也不用重新构建框架。开发时社区插件的文件变化会自动重载注册表；其他环境要重启服务端。

### 沙箱

HTML 跑在两层 `sandbox="allow-scripts"` 的 iframe 里。每一层都是独立的 opaque origin，拿不到宿主的 DOM、cookie、localStorage 或 provider key。

| 层   | 是什么                                                                                       | 作用                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 外层 | Web 构建自带的静态文档 `/plugin-frame.html`，按 URL 加载，带自己的 CSP（不继承主页面的策略） | 只做两件事：把插件 HTML 放进内层；传递一次桥接端口。它的 `frame-src 'none'` 阻止内层导航到网络地址。 |
| 内层 | 插件的 HTML，通过 `srcdoc` 加载，继承外层的策略                                              | 可以用内联脚本（包括 `onclick` 这类内联事件属性）、内联样式、DOM、Canvas、SVG 和动作桥。             |

插件 HTML 不需要为这套结构做任何改动。需要知道的限制：

- 插件改不了外层的策略，也不能让外层或顶层页面跳转。
- 内层文档重新加载后，不会再拿到桥接端口。HTML 文件变了，宿主会重新创建整个容器。
- CSP 禁止 fetch、表单提交、加载外部脚本和样式。依赖和资源要打包成内联内容或 data 资源。
- 不要在 HTML 里直接调用 Covel 的 HTTP API。
- 桥接传来的状态属于插件可读的数据，不应该含密钥。
- 这条界面边界不改变服务端插件代码的信任模型，也不提供 CPU、内存或渲染资源的配额。

### `window.covel`

宿主往页面里注入 `window.covel`：

```js
const unsubscribe = window.covel.subscribe(
  ({ data, locale, locked, context, uiState, theme }) => {
    // Render with textContent or your UI framework's escaping.
  },
);
const snapshot = window.covel.getState();
const response = await window.covel.invoke("invokePluginAction", {
  action: "refresh",
  payload: { limit: 10 },
});
```

状态里的字段：

| 字段      | 内容                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data`    | 本插件声明的 namespace 的数据。更新和删除都随宿主的数据源传过来。                                                                                                                                |
| `locale`  | 当前语言。                                                                                                                                                                                       |
| `locked`  | 交互锁。宿主也会拒绝锁定期间发来的动作。                                                                                                                                                         |
| `context` | 在舞台上是 `{ surface: "stage", turnId, turnIds, choices }`。`turnIds` 包含属于当前叙事的已提交重试；`choices` 是当前的 `{ id, text }[]`。插件可以用它们核对回合和当前选项，把过期的结果藏起来。 |
| `uiState` | 这个面板的临时状态，见下。                                                                                                                                                                       |
| `theme`   | 当前风格方案，见下。                                                                                                                                                                             |

### 跟随主题

`theme` 是 `{ id, scheme: "light" | "dark", tokens }`。`tokens` 是一组已经解析好的字符串：

`background`、`surface`、`foreground`、`mutedForeground`、`border`、`accent`、`accentForeground`、`success`、`warning`、`danger`、`radiusControl`、`radiusCard`、`fontSans`、`fontSerif`、`fontDisplay`。

宿主同时把它们写成文档根元素上的 CSS 变量，名字是驼峰转连字符：`--covel-background`、`--covel-font-sans` 等。它还设置 `color-scheme` 和 `data-covel-scheme`。所以样式表里可以直接写 `color: var(--covel-foreground)`，玩家切换方案或明暗时自动更新。

> [!NOTE]
> 沙箱里加载不了宿主的字体文件。字体变量只在系统已经装了对应字体时生效，记得写回退字体。

### 可以发出的动作

桥只接受宿主明确提供的动作：

| 动作                                                   | 哪里可用 | 说明                                     |
| ------------------------------------------------------ | -------- | ---------------------------------------- |
| `invokeRuntime`、`invokePluginAction`、`invokeCommand` | 都可用   | 执行类动作，自动绑定当前插件。           |
| `emitEvent({ topic, data })`                           | 都可用   | 发出本插件声明的事件。                   |
| `draftMessage({ text, selectionGroup? })`              | 右侧面板 | 把一句话放进待发送区，由玩家确认后发出。 |
| `sendMessage({ text })`                                | 舞台     | 把文字填进舞台输入框，由玩家确认发送。   |
| `setUiState({ value })`                                | 都可用   | 保存面板的临时状态，见下。               |

不能通过参数改写 pluginId 去调用别的插件。需要和别的插件配合时，从自己的 runtime 里用 `ctx.services` 或事件，不要在浏览器里读对方的私有数据。

执行类动作返回现有的 RPC 响应。后台的 `accepted` 只表示任务已被接收，不代表完成。桥接通信和调用的异常以不含服务端内部细节的错误返回。每个挂载实例有自己的连接，卸载时关闭。插件拿不到宿主里的任意函数。

### 面板的临时状态 `uiState`

`uiState` 是当前面板的一份临时 JSON 状态，初始为 `null`。用来保存草稿这类不必进服务端的东西。

```js
await window.covel.invoke("setUiState", { value: { draft: "..." } });
```

- 每次调用整体替换。传 `value: null` 清空。成功返回 `{ status: "ok" }`。
- 编码成 JSON 后最多 32 KiB（UTF-8）。非法值或超限会被拒绝，旧值保留。
- 它和 `data` 互不相干：不写服务端，不调用 runtime。
- 这个动作同样受交互锁约束。

它能保留多久：

- 侧栏按会话、插件和面板分别缓存，切换标签后可以恢复。
- 需要恢复草稿的面板应声明一个稳定的 `id`。没有 `id` 的面板用它在包里的顺序生成身份。
- 离开会话、销毁侧栏宿主或刷新页面，状态丢失。
- 不提供缓存的其他位置只保留到面板卸载。

> [!TIP]
> 在第一次收到宿主状态时恢复草稿。之后的状态推送不要再覆盖输入框，否则会冲掉玩家正在输入的内容。

## 可安装的组合示例

- [Clickable Map](../../tests/third-party/clickable-map/README.md)（在本仓库里）：自绘面板的最小示例。`webview` 用宿主的方案变量画地图；点击经 `emitEvent` 交给事件 runtime 校验并写入；`draftMessage` 把移动交给叙事；`session.summary@1` 报告当前位置。`pnpm e2e:extensions` 在真实浏览器里跑它。
- [官方记录工作台 demo 与两个处理服务](https://github.com/covel-ai/covel-plugins/tree/main/examples/notes-workbench)（在插件仓库里，不随 Covel 一起安装）：展示包级 HTML UI、`/notes` 命令、手动函数 runtime、服务发现，以及可以替换的只有 entry 的提供者。工作台只写自己的记录，服务只负责计算；原样保存、格式整理和项目列表都不用模型。新增的提供者通过 `examples.note-format@1` 契约接入，框架和工作台都不按提供者 ID 分支。

## 开发时查看注册与调用

在会话里输入 `/plugins`，打开调试页的插件视图。输入 `/plugins my-plugin` 则只看这个包，以及它作为调用方或提供方的服务记录。

这个命令由框架的命令目录提供：可以搜索、自动补全，走现有的命令 RPC 校验和追踪。它不消耗玩家回合，也不调用模型。`/debug` 和 `/trace` 仍然打开原来的调试入口。

### 插件视图里有什么

- 安装来源，以及当前会话里的启用和授权状态。
- runtime ID。
- 实际注册的工具、Hook、RPC action、服务，以及声明的 slash command。

读这个视图时注意：

- `registered` 只表示命令的 action 已经注册。实际执行时仍检查命令参数、会话和对应 action 的权限。
- 没启用或没授权的包，不会显示成当前可用的注册能力。
- 这次查询只读宿主的注册表和会话的依赖解析结果。它不触发 entry、服务发现或任何插件代码。
- 错误信息用固定的说明文字。宿主识别出注册错误时，会展示结构化的 `registrationError`（`code` / `registration`）。具体的异常要去服务端日志里找。

### 最近的服务调用

| 项目       | 说明                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 保存在哪里 | 只在当前服务进程的内存里。重启后清空；请求落到别的进程时看不到这边的历史。               |
| 数量       | 全进程最多 500 条。每次返回当前会话最近的 100 条，可以按插件筛选。                       |
| 记录什么   | 谁调了谁、属于哪个 runtime 和回合、耗时、成功 / 失败 / 超时 / 取消，以及固定的错误分类。 |
| 不记录什么 | 参数、结果、原始异常、会话的私有标识。                                                   |

所以这个窗口不能当作持久审计或用量统计。其他细节：

- 没有取得调用方准入范围的调用，不进入会话历史。
- 会话删除后用同一个 ID 重建，读不到旧记录。
- 没匹配到服务的请求用 `<unavailable>` 标识。
- 过长的诊断字符串截到 256 个 UTF-16 单元，并标上 `...[truncated]`。
- 页面支持手动和自动刷新。会话和筛选条件不变时，刷新保留当前列表，滚动位置不会被清空。切换会话或筛选条件时立即隐藏旧数据；查询失败时也清除已显示的数据。

接口见[插件诊断 API](./api.md#get-apisessionsidplugin-diagnostics)。本地组合调试先用 [test-runtime 的 --with-plugin](../plugins/testing.md#coveltest-runtime)，再用真实的服务端验证审批、slash 命令、Hook 和界面。

### 扩展调用的失败与 trace

一次扩展点调用的输出要过三步：扩展点的 output schema、权威归属处理、最终的 schema 校验。三步算作同一次调用的结算。

- 槽位类型不匹配这类最终错误，记为一次 `error / output-validation`，然后由扩展点的 `onError` 决定 skip 还是 fail-turn。不会先记一次 success 再补一次 failure。
- 超时之后才到的结果不会追加一条 success。

**持久 trace。** 带回合 emitter 的扩展调用、压缩调用和函数服务调用，用同一种完成事件 `plugin.service.completed` 写入持久 trace。嵌套调用继承 emitter，并带上 `parentCallId`。

- 事件只包含身份、扩展点的 point / id / slot、耗时和固定的结果分类。
- 事件不含调用的输入、输出、原始错误、凭据，或会话的私有标识。
- 它复用现有 TurnEmitter 的 traceId、seq 和重试范围，并等写入尝试完成。存储失败时按 trace 一贯的“尽力记录”处理，不改变插件的结果。耗时不包含写 trace 的时间。
- 没有回合 emitter 的界面后台投影，只留在进程内的诊断窗口里。

**提供者被跳过时去哪里找原因。** `onError` 为 skip 的扩展点跳过一个失败或超时的提供者时，服务端日志里有一行：

```text
[plugin-extensions] skipped provider <pluginId>/<extensionId> of <point> for session <sessionId>: <原因>
```

trace 事件不含原始错误。自己的片段或槽位没有出现时，作者在这一行里找原因。

宿主的调用方可以在 `createExecution` 的作用域里传 `onProviderError`，在跳过发生时拿到提供者标识和原始错误。历史压缩用它把原因写进回合 trace，见[扩展点参考](./extension-points.md#历史压缩-historycompact2)。

**诊断里的统计。** 诊断按当前返回的最近 100 条调用（全进程最多保留 500 条）计算每个 point / provider 的 total、success、error、timeout、cancelled。

- 缓存命中，以及同一次执行里被合并的并发调用，不增加事件和统计。
- 没激活或没批准的提供者在发现阶段就被排除，不算调用失败。
- 调用发出之后准入失败的，保留失败事件。
- 这份统计只代表当前窗口，会随旧记录被淘汰而变化，不是累计用量。
