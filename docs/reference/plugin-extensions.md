# 插件扩展边界与通信

插件通过公开契约组织模型调用、函数与 UI。框架提供发现、授权、调度、校验、取消和挂载；业务数据结构、算法、供应商 wire 与组件实现留在插件包内。仓库中的 [Lifecycle Probe](../../tests/third-party/lifecycle-probe/README.md) 和 [Service Provider Probe](../../tests/third-party/service-provider-probe/README.md) 组成可独立安装的双插件样例，覆盖命令、面板、手动函数、数据提交和服务协作。另有 [Jev 选项推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo)。

## 选择通信方式

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

`ctx.services` 当前向 function runtime 开放。Agent 可通过插件自己的 function runtime 取得服务结果，再通过 `inputs` 接收，或继续使用已注册本地工具。它不会自动把全部公共服务暴露给每个 Agent。

Runtime 发出的事件在同轮事件链中按深度匹配订阅者。每个深度的同步匹配集合按声明的 `needs` / `after` / `inputs` DAG 执行，层间结果对下游立即可见；它不会额外触发未匹配的提供者。后台 follower 和 UI 发出的事件订阅任务仍是独立 durable job，同步 DAG 不提供跨作业排序或成功门控。

单提供者契约 `needs` 可以由前一阶段或事件深度的已满足结果提供依据；当前批次的替代提供者形成循环时，已满足该需求的消费者仍可运行。`after`、全提供者需求和输入绑定仍保留自己的排序约束。

UI 的 `invokePluginAction` 调用插件 RPC action，其写入即时生效，handler 后续失败不会自动回滚。多条记录必须一起成功或失败时，用 `invokeRuntime` 触发 `trigger.type: manual` 的 function runtime：`ctx.pluginData` 写入和领域 effects 进入同一次 proposal 提交。该 function handler 不需要 LLM，手动触发本身也不会运行叙事 runtime；声明的事件下游仍按调度契约执行。`invokeCommand` 适用于 manifest 声明的玩家命令，不能用 `invokePluginAction` 绕过命令校验与审计。参见 [RPC 通道](api.md#post-apisessionsidplugin-rpc)与 [handler 写入契约](plugins.md#输入和输出)。

插件工具在 `entry` 工厂中通过 `covel.registerTool()` 注册，名字在插件内唯一；不同插件同名不会互相覆盖。工具调用只解析调用方插件的实现和框架内置工具，跨插件公共调用使用下文的 services。

只有 `entry`、Hook 或 UI 的包可以没有 runtime。它的 Hook 仍按会话已启用的插件集合执行，`ctx.getOwnSettings()` 读取包级 `userSettings` 默认值与本次世界、玩家覆盖值；没有 runtime 不会丢失这些默认值，也不会凭空调度一个 runtime。执行与提交各使用明确的会话 Hook scope；嵌入式 `executeTurn` 调用方如需包含零 runtime 包，应在 `TurnExecutorDeps.hookScope` 传入其 `activePluginIds` 和已解析的 `settings`，执行入口会捕获并冻结该边界，随后随 `execution` 自动传入 `commitExecution`。宿主从持久会话激活集合构造 scope，社区 Hook 每次调用仍检查当前 server-code 授权。

每个 Hook 事件的触发时机、负载、可返回的结果和 handler 收到的上下文见 [Hooks](hooks.md)。`contributes.hooks` 按 `event` 与 `enforce` 声明允许的 Hook，省略 `enforce` 等同于 `normal`。同一声明可以通过多次 `covel.on()` 注册多个独立 handler；未声明的事件或阶段、以及没有实现的声明仍会使整个 entry 发布失败。

同一事件的 handler 按 `enforce` 分组依次执行：`pre` → `normal` → `post`。组内先执行框架 Hook，再按注册顺序执行插件 Hook；不同插件之间的先后取决于插件的加载顺序，不是可声明的契约。两个插件改写同一份负载时，后执行的 `replace` 覆盖先执行的同名字段，需要确定先后的插件应声明不同的 `enforce`。

`TurnStop` 在一次执行的全部 runtime 结束之后、提交之前触发：此时本次执行的写入还没有落库，也可能在提交时被拒绝。需要在数据落库之后响应的插件使用 `PostStateCommit`。

## 插件作者类型

外部插件从公开包 `@covel/plugin-handlers-utils` 导入 `PluginAPI` 或 `PluginEntryFactory` 类型，无需安装私有的 runtime/shared workspace 包。`@covel/plugin-handlers-utils/extension-points` 提供扩展点的输入、输出和上下文类型；完整入口类型也可从 `@covel/plugin-handlers-utils/plugin-api` 导入。

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

使用 TypeScript 或开启 JavaScript 的 `checkJs` 后，已知扩展点会约束 handler 的输入和输出。清单声明与运行时 schema 校验仍然必需；类型检查不能代替授权或输出校验。

插件 JavaScript 模块的相对导入必须指向包中实际存在的文件。若导入未经编译的 TypeScript helper，应写真实的 `.ts` 后缀。仓库源码开发通过 `pnpm dev` 的 tsx 加载器启动；Node 的类型剥离本身不会把 workspace 源码中的 `.js` 导入映射到 `.ts`，因此直接用裸 `node import(...)` 加载整个源码依赖图不属于该开发启动方式。

## Entry 资源生命周期

`covel.signal` 对应本次插件激活。初始化失败或宿主关闭时信号取消；`covel.onDispose(callback)` 在工厂执行期间登记同步或异步清理函数，适合关闭订阅、连接、计时器和共享缓存。资源取得后应立即登记清理，再执行下一步可能失败的初始化。

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

关闭先取消信号、停止接收新注册，再撤销已发布的能力，最后逆序等待清理函数。一个清理失败不阻止其他清理；错误会汇总报告，重复关闭不会再次执行回调。初始化失败同样清理已取得资源，重试使用新的 signal。测试运行器执行完成或失败后也会关闭入口资源。

服务端 entry 初始化默认最多等待 15 秒；失败回滚清理另有最多 15 秒的等待预算。清理超时不会阻止失败返回、后续重试或其他会话捕获快照，宿主关闭时仍报告未完成的失败清理。失败后的被动服务发现默认退避 30 秒，显式激活与重载可重试。

首次激活与重载的准备按插件串行执行。工厂运行、runtime 模块加载和失败资源清理不占用全局发布队列；不同插件或不依赖该插件的会话可以继续执行。捕获 runtime 期间若有新代发布，宿主会重新取得快照，确保同次执行的工具、服务和 runtime 来自一致的发布状态。

entry 在宿主内按插件激活一次，**不属于某个会话**。禁用一个会话中的插件不会销毁其他会话共用的 entry；会话数据仍使用调用上下文和插件数据存储，不放到共享模块闭包中。单次任务使用 `ctx.signal`，需要会话结束通知时使用 `SessionEnd` Hook。此接口依靠插件配合取消和完成清理，不能强制终止忽略信号的 JS，不提供独立后台调度器。

宿主目录的 `hostState` 只描述实际 entry 发布状态（`discovered / installed / loaded / error`），不再包含 `approved`。会话 API 单独提供实时 `serverCodeApproved` 与依赖解析后的 `sessionState / autoAdded / rejection`；不能从全局 `loaded` 推断另一个会话的授权。首次激活失败显示 error，重载失败但旧代保留时仍显示 loaded，错误信息独立展示。

## 开发时单插件热重载

仅 `NODE_ENV=development` 启用社区插件热重载，builtin 包与生产环境不允许。`POST /api/plugins/:id/reload` 接收可选 `{ "sessionId": "..." }`；操作须通过安装 API 的本机/管理员鉴权，并由指定会话（省略时使用曾批准此插件的会话）提供当前有效的 server-code 授权。开发宿主同时监听社区插件目录，150 ms 合并文件变化后使用相同路径重载；没有有效授权时拒绝执行插件代码。

启动时静态解析失败的社区插件也保留独立的发现位置并接受文件监听。

重载只沿用该包的 ID、根目录与发现来源，按当前文件重新检查布局，不继承旧的 `layoutError`；补齐根 `PLUGIN.md` 或纠正子清单文件名后可重新恢复。新扫描仍有错误时，不发布新声明，也不清除失败发现位置。修正文件后，如果它从未发布活动能力，宿主可以在没有 server-code 授权时重新校验并发布静态声明；不会导入 entry、handler 或 guard，首次激活仍须走正常审批。已有活动代的插件不能使用此恢复路径。监听目录消失只记录警告，不中断宿主启动。

宿主先解析新声明、运行新 entry 工厂并校验注册契约，再预加载已获 server-code 与 runtime 双授权的 handler/guard，最后一次发布工具、Hook、RPC、服务、表单校验器、wire 与 runtime 元数据。准备失败保留旧代。进行中的执行捕获旧代引用；后续执行使用新代。旧代停止接收新查找，等待已捕获执行及超时后仍未结束的 provider promise 释放，再调用 `onDispose()`。快照不保留授权，调用和提交仍检查实时撤销状态。

重载发布后，每个会话的下一次执行会在捕获新快照前，按原始请求、显式排除和当前授权重新解析依赖图。新增的必需契约缺少提供者或产生互斥冲突时，该插件不能沿用旧的激活结果执行；修正声明后仍保留用户原始选择。已开始的执行保留原有激活图和服务引用，但显式停用、撤销授权或替换会话仍使其失效。

事件 schema 在启动及新代准备期间读取并编译，编译结果和失败都按声明代际缓存，然后才发布新声明。同一路径的文件修正通过下一次重载生效；已捕获的旧代即使尚未调用过该事件，也保持原有校验器，不受磁盘后续编辑影响。

直接 entry、handler 与 guard 模块使用代次 URL 重新导入。**相对导入的依赖模块不会随之失效**：需热更新的逻辑必须位于直接加载模块或其 entry 工厂内部，相对依赖应保持稳定；修改相对依赖、宿主代码或不能安全清理的顶层资源时重启服务。ESM 的旧模块缓存由 Node 持有，长时间反复开发重载可通过重启回收。

## 公共函数注册与调用

服务在已有 `entry` 工厂运行期间注册。注册与工具、hook、RPC 一起原子发布，失败回滚，关闭宿主时解除注册。服务名在所属插件内唯一；`contract` 是插件作者定义的公开契约标识，建议显式携带版本。不兼容修改使用新的契约，不添加开发数据迁移。

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

其他插件使用 `ctx.services.discover("my-plugin/rank@1")` 获得 `{ pluginId, name, contract, description? }[]`，再显式选择调用目标。多个供应者时由调用插件设置或业务规则决定，不按插件名字猜测，不自动选择第一个服务。

```js
const value = await ctx.services.call({
  pluginId: configuredProviderId,
  name: "rank",
  contract: "my-plugin/rank@1",
  input: { candidates: ["Visit the library", "Explore the classroom"] },
});
```

可以为一次服务调用设置比 runtime 更短的预算，或单独取消它：

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

`timeoutMs` 为正有限毫秒数，最大 `2147483647`，包含准入等待和实际执行；超时抛出 `name: "TimeoutError"` 的异常，局部取消保留取消原因。父 runtime 取消同样有效，单次调用的超时或取消不会取消父 runtime，调用方可捕获错误后选择备用提供者。嵌套服务及 gateway/HTTP 继承该调用信号。调用结束即关闭其上下文，不能保存它以在返回后继续发起工作。未配合取消的异步代码可能继续运行，但调用方及时结束等待，迟到结果不作为成功结果返回。

调用前重新检查调用方、供应方是否仍活跃，以及社区服务端代码是否获准运行。发现接口不会激活未获准运行的社区代码。注册在进程中存在不等于当前会话可调用。

服务输入和输出经过 schema 校验与结构化复制，不能借对象引用修改对方状态。上下文只有 `callerPluginId`、`signal`、`gateway`、`utils`、`services`；没有调用方的 store、工具、设置或写入缓冲。服务计算结果，调用 runtime 决定如何提交效果。服务调用链拒绝循环，最多八层；继承 runtime 的截止时间和能力撤销。服务必须传递 `signal` 给异步工作，不能把任务留在脱离调用的后台。普通服务端 JS 仍遵循既有社区代码授权模型，并不是进程级沙箱。

## 模型与新协议

- 已支持的模型能力：复用 `ctx.gateway`、`ctx.images`、`ctx.speech`、`ctx.music`。Evaluation 使用 `ctx.gateway.evaluate({ presetId, state, questions, signal })`，支持 Boolean、Choice、Score。
- 自行拼装长提示词时，`ctx.gateway.resolveSlot({ presetId })?.limits` 给出 gateway 对该 slot 实际采用的 `{ contextWindow, maxOutputTokens }`；模型未声明上下文窗口时省略，不把框架兜底值当作真实上限。`generateText` / `generateObject` 可传 `maxOutputTokens` 作为单次调用上限，只能低于玩家为该 slot 配置的输出预算，不能提高它。
- 新供应商使用既有 wire：只配置 provider、base URL、模型和用途，无须改插件或框架。
- 新 wire 或新的返回形式：服务内部用 `ctx.gateway.resolveSlot` 取得本次请求的模型配置，再用 `ctx.utils.validateBaseUrl` / `fetchWithRetry` 实现协议，定义自己的输入输出 schema。结果通过服务契约提供给其他插件。密钥只留在服务端，不写入结果、日志或 UI。
- 图片、语音、转写和音乐需要复用统一媒体管线时，继续使用 `covel.registerWires`。媒体落库仍通过现有媒体接口。
- 新的文本协议（内置四种之外的请求和响应格式，例如某家云的原生接口）也用 `covel.registerWires` 注册，见下文[文本协议 wire](#文本协议-wire)。注册后它和内置协议一样可以被任何文本用途选用，主叙事也可以。
- 音乐生成：`ctx.music.generate({ prompt, lyrics?, instrumental?, durationSeconds?, format?, presetId?, metadata?, signal? })` 返回 `{ refs, warnings, cached }`，与 `ctx.speech.generate` 同一套去重和落库约定；`ctx.music.isAvailable(presetId?)` 只检查有没有配置音乐用途，不请求服务商。内核不带音乐 wire：提供音乐模型接入的插件用 `covel.registerWires({ music: [{ id, compose }] })` 注册，`compose(config, params, context)` 返回 `{ audio: { mimeType, data }, usage, warnings }`，需要轮询的服务商在 `compose` 里轮询完再返回。一首曲子要生成几十秒到几分钟，只应在 detached 或后台 runtime 里调用，不要放进回合。

服务中的 gateway 和 HTTP 工具继承调用 runtime 的请求配置、权限、追踪、取消和撤销边界，不会因为跨插件调用获得更大权限。尤其社区调用方的自管 HTTP 仍受其 `permissions.http` 限制。已提供标准 gateway 方法的能力优先走 gateway。

“无须修改框架”指插件能以自己的契约实现功能。若希望框架的通用模型设置、调度器或媒体系统直接理解一种全新能力类型（文本、图像、语音、转写、音乐、评估之外的），仍属于宿主公共契约的演进；服务扩展不会自动给中心能力枚举添加新成员。

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

- 和图片、语音等 wire 一样，文本 wire 的 `id` 要写进清单的 `contributes.wires`（上例为 `wires: [converse]`）；注册了没声明，或声明了没注册，插件都加载失败。
- 注册名是 `<pluginId>/<wireId>`（上例为 `acme/converse`）。模型的 `protocol` 写这个名字即可，`llm.toml` 和设置页都认；设置页的协议下拉通过 `GET /api/ai/protocols` 列出已加载插件注册的协议，名称取 `label`。
- 必须实现 `generateText` 和 `streamText`。`params` 带 `model`、`messages`（含工具调用与工具结果）、`tools`、`responseFormat` 和 `providerRequestMetadata`；流的最后一个事件必须是 `done`。类型见 `@covel/plugin-handlers-utils` 的 `PluginTextWire`。
- `finishReason` 可以直接返回服务商自己的词，网关统一成 `stop` / `length` / `tool_calls` 等（见 [slots.md](slots.md#连接测试与失败原因) 上文的结束原因说明）。
- 结构化输出不用单独实现：网关把 JSON Schema 放进 `responseFormat` 并作为指令加入消息，调用 `generateText`，再解析和校验结果。embedding 不走文本 wire。
- 可选的 `listModels(config, signal)` 返回端点提供的模型 ID，设置页的“从服务读取模型列表”会用它。
- wire 自己发 HTTP，所以这些请求不出现在 provider 请求追踪里，框架的传输重试和请求预算也不作用于它；`config.signal` 在调用被取消或超时时触发，应传给请求。
- `config` 里有该用途解析出的地址和密钥。它们只能用于向该地址发请求，不得写入结果、日志或 UI。模型的 `protocol` 指向的插件没有加载，或没有在当前会话启用时，调用以配置错误失败（错误里写明要启用哪个插件），不会改用别的协议。
- 哪些请求可以选用这个协议：会话里该插件处于启用状态（社区插件的启用已含玩家授权）。不属于任何会话的请求（连接测试、读取模型列表、生成世界）可以选用内置插件的协议；`self` 形态下只有一个玩家，已加载的社区插件都经他授权，所以也可以选用社区插件的协议；托管形态下社区插件的协议要在已启用它的会话里使用。请求级预设、`llm.toml` 的槽位和 runtime 自己的槽位偏好都按这条判断；设置页的协议下拉仍列出所有已加载插件的协议。
- 信任边界与媒体 wire 相同：社区插件的服务端代码要玩家授权后才运行，`permissions.http` 声明的来源照常强制。不同的是，文本 wire 会经手选用它的那个用途的全部提示词和回答。

## 自定义组件与挂载

插件在 `ui.right` 声明一个 JSON 外壳。`view` 和 `webview` 二选一；不再要求所有业务 UI 都加入框架组件 catalog。

```json
{
  "id": "my-widget",
  "label": "My widget",
  "surfaces": ["panel", "stage"],
  "dataSource": { "namespace": "results" },
  "webview": { "entry": "./widget.html", "height": 280 }
}
```

右侧面板的每个插件面板都带一个「放大」按钮，把同一个面板移到大对话框里显示（同一时刻只有一个实例；`webview` 在那里占用约 72vh 的高度，不受 `height` 限制）。这是宿主行为，spec 不需要声明。

`surfaces` 缺省为 `panel`；声明 `stage` 后，该面板会挂载在舞台决策区域。这个位置同样支持 JSON `view`。它不检查业务 capability，不了解推荐、骰子、地图或任何具体插件。宿主只提供已有挂载位置；新增一个产品级全局位置仍需要宿主提供。

`webview.entry` 相对 JSON 文件，必须是插件根目录内的 `.html`，真实路径（包括符号链接）不能越界，单文件最多 512 KiB。可使用原生 DOM、Canvas、SVG，或将 React/Vue 等构建成包含脚本和样式的单个 HTML。无需修改 Web 源码或重建框架；开发时社区插件文件变化自动重载注册表；其他环境需要重启服务端。

HTML 使用两层 `sandbox="allow-scripts"` iframe，每层均为独立 opaque origin，没有宿主 DOM、cookie、localStorage 或 provider key 访问权。可信外层是 Web 构建自带的静态文档 `/plugin-frame.html`，按 URL 加载，带自己的 CSP（不继承主页面的策略；主页面不允许内联脚本）。它只负责把插件 HTML 放进内层并传递一次桥接端口，其 `frame-src 'none'` CSP 阻止内层向网络地址导航；插件不能修改外层策略，也不能导航外层或顶层页面。内层通过 `srcdoc` 加载并继承外层的策略，保留内联脚本（包括 `onclick` 这类内联事件属性）、内联样式、DOM、Canvas、SVG 与动作桥；文档重新加载后不会重新获得端口，HTML 变更则重新创建容器。插件 HTML 不需要为此做任何改动。CSP 同时禁止 fetch、表单提交及外部脚本/样式加载，依赖与资源应打包为内联或 data 资源。不要在 HTML 中直接调用 Covel HTTP API。桥接状态属于插件可读数据，不应含密钥；此 UI 边界不改变服务端插件代码的信任模型，也不提供 CPU、内存或渲染资源配额。

宿主注入 `window.covel`：

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

`data` 是本插件声明 namespace 的数据；更新和删除均随宿主数据源传入。`context` 在舞台包含 `{ surface: "stage", turnId, turnIds, choices }`；`turnIds` 包含归属当前叙事的已提交重试，`choices` 为当前 `{ id, text }[]`。插件可核对回合及当前选项，隐藏过期结果。`locked` 为交互锁；宿主也会拒绝锁定时发来的动作。

`theme` 是当前风格方案：`{ id, scheme: "light" | "dark", tokens }`。`tokens` 是一组已解析的字符串：`background`、`surface`、`foreground`、`mutedForeground`、`border`、`accent`、`accentForeground`、`success`、`warning`、`danger`、`radiusControl`、`radiusCard`、`fontSans`、`fontSerif`、`fontDisplay`。宿主同时把它们写成组件文档根元素上的 CSS 变量（`--covel-background`、`--covel-font-sans` 等，驼峰转连字符），并设置 `color-scheme` 与 `data-covel-scheme`，所以样式表里可以直接写 `color: var(--covel-foreground)`；玩家切换方案或明暗时自动更新。沙箱里加载不了宿主的字体文件，字体变量只在系统已安装对应字体时生效，记得写回退字体。

桥接只接受宿主显式提供的动作：执行类动作默认是 `invokeRuntime`、`invokePluginAction`、`invokeCommand`、`emitEvent({ topic, data })`，自动绑定当前插件；右侧面板另提供 `draftMessage({ text, selectionGroup? })`（把一句话放进待发送区，由玩家确认后发出），舞台另提供 `sendMessage({ text })`。不可通过 params 改写 pluginId 来调用其他插件。需要组合其他插件时，从自己的 runtime 使用 `ctx.services` 或事件，不通过浏览器读取对方私有数据。

`uiState` 是当前面板的临时 JSON 状态，初始为 `null`。使用 `await window.covel.invoke("setUiState", { value: { draft: "..." } })` 整体替换，传 `value: null` 清空；成功返回 `{ status: "ok" }`。对象编码为 JSON 后最多 32 KiB（UTF-8），非法值或超限会拒绝且保留旧值。它与 `data` 隔离，不写服务端、不调用 runtime。侧栏按会话、插件及面板隔离缓存，切换标签后可恢复；建议为需要恢复草稿的面板声明稳定 `id`，无 `id` 面板使用包内顺序生成身份。离开会话、销毁侧栏宿主或刷新页面会丢失。不提供缓存宿主的其他位置只保留到面板卸载。插件应在首次收到宿主状态时恢复草稿，避免后续状态推送覆盖正在输入的内容。此动作同样受交互锁约束。

执行动作返回现有 RPC 响应；后台 `accepted` 表示任务已接收，不代表完成。桥接通信和调用异常以不含服务端内部详情的错误返回。每个挂载实例独立连接，卸载时关闭；插件不能获取宿主中的任意函数。

## 可安装的组合示例

仓库内的 [Clickable Map](../../tests/third-party/clickable-map/README.md) 是一个自绘面板的最小示例：`webview` 用宿主的方案变量画地图，点击经 `emitEvent` 交给事件 runtime 校验并写入，`draftMessage` 把移动交给叙事，`session.summary@1` 报告当前位置。`pnpm e2e:extensions` 在真实浏览器里跑它。

[官方记录工作台 demo 与两个处理服务](https://github.com/covel-ai/covel-plugins/tree/main/examples/notes-workbench) 展示包级 HTML UI、`/notes` 命令、手动 function runtime、服务发现和可替换的 entry-only 提供者。完整示例维护在插件仓库，不随核心插件分发。工作台只写自己的记录，服务只计算；原样保存、格式整理和项目列表均不使用 LLM。新增提供者通过 `examples/note-format@1` 契约接入，框架和工作台不按提供者 ID 分支。

## 开发时查看注册与调用

在会话输入 `/plugins` 打开调试页的插件视图，或输入 `/plugins my-plugin` 同时筛选该包及其作为调用方或提供方的服务记录。命令由框架命令目录提供，可搜索、自动补全并走现有 command RPC 校验和追踪，不消耗玩家回合，也不调用 LLM。`/debug` 和 `/trace` 继续打开原调试入口。

插件视图展示安装来源、当前会话的启用与授权状态、runtime ID、实际注册的工具、Hook、RPC action、服务及声明的 slash command。`registered` 只表示命令 action 已注册，实际执行仍检查命令参数、会话和对应 action 的权限。未启用或未授权的包不会展示为当前可用的注册能力。查询只读宿主注册表和会话依赖解析，不触发 entry、服务发现或插件代码；错误信息使用固定说明，并在宿主识别到注册错误时展示结构化 `registrationError` 的 code/registration，具体异常从服务端日志排查。

最近服务调用只保存在当前 server 进程内，全局最多 500 条，每次返回当前会话实例最近 100 条，可按插件筛选。记录调用关系、所属 runtime/turn、耗时、成功/失败/超时/取消与固定错误分类，不记录参数、结果、原始异常或会话私有标识。未取得调用方准入范围的调用不进入会话历史；删除后同 ID 重建的会话无法读取旧记录。重启或请求落到其他进程时不会共享历史，因此该窗口不能用于持久审计或用量统计。未匹配服务的请求使用 `<unavailable>` 标识，超长诊断字符串截断至 256 个 UTF-16 单元并标记 `...[truncated]`。页面支持手动与自动刷新，同一会话及筛选条件下刷新时保留当前列表，避免滚动位置被清空；切换会话或筛选条件时立即隐藏旧快照，查询失败时也清除已显示的数据。

接口见 [插件诊断 API](api.md#get-apisessionsidplugin-diagnostics)。本地组合调试使用 [test-runtime 的 --with-plugin](../guide/plugin-testing.md#coveltest-runtime)，然后用真实 server 验证审批、slash、Hook 和 UI。

### 扩展调用的失败与 trace

扩展输出先经过点的 output schema，再执行权威归属处理与最终 schema 校验；三步均在一次 service 调用的结算边界内。槽位类型不匹配等最终错误记录为一次 `error / output-validation`，然后由点的 `onError` 决定 skip 或 fail-turn，不会先记 success 再补 failure。超时后的迟到结果不追加 success。

具有回合 emitter 的扩展、压缩与 function service 调用使用同一 `plugin.service.completed` 完成事件写入持久 trace，嵌套调用继承 emitter 并携带 parentCallId。事件只包含身份、扩展 point/id/slot、耗时和固定结果分类，不含调用输入、输出、原始错误、凭据或私有 session incarnation。复用既有 TurnEmitter 的 traceId、seq 和重试范围，等待写入尝试完成；存储失败沿用 trace 的尽力记录语义，不改变插件结果，耗时不包含 trace I/O。没有回合 emitter 的 UI 后台投影只保留进程内诊断窗口。

`onError` 为 skip 的点跳过失败或超时的提供者时，服务端日志记录一行 `[plugin-extensions] skipped provider <pluginId>/<extensionId> of <point> for session <sessionId>: <原因>`。trace 事件不含原始错误，作者在这一行查找自己的片段或槽位没有出现的原因。宿主调用方可以在 `createExecution` 的作用域里传 `onProviderError`，在跳过发生时拿到提供者标识与原始错误；历史压缩用它把原因写进回合 trace，见[扩展点参考](extension-points.md#历史压缩-historycompact2)。

诊断按当前返回的最近 100 条调用（全进程最多保留 500 条）计算 point/provider 的 total、success、error、timeout、cancelled。缓存命中与同执行并发合并不增加事件或统计；未激活或未批准的提供者在 discovery 被排除，不算调用失败；调用发出后准入失败则保留失败事件。该统计仅代表当前窗口，会随淘汰变化，不是累计用量。

`@covel/plugin-handlers-utils` 导出 `estimateTokens` 和 `FRAMEWORK_TOOL_NAMES`，宿主使用相同实现。hook 未返回值时继续；转换 hook 故障不撤销之前的改写，安全守卫故障仍拒绝操作。

公开 SDK 提供 `resolveI18nText` / `resolveI18nDeep`、locale registry、`estimateTokens`、表单工具和角色字段校验。`world.dimensions@1` 的提供者使用 `@covel/plugin-handlers-utils/dimensions` 的 schema 与 materializer。Node 插件用 `@covel/plugin-handlers-utils/prompts` 的 `createPromptLoader(root)` 加载自己的模板；该子入口不进入浏览器根模块。`shared` / `tools` / `context` 复用这些实现，插件代码只依赖 SDK。
