# 插件扩展边界与通信

插件通过公开契约组织模型调用、函数与 UI。框架提供发现、授权、调度、校验、取消和挂载；业务数据结构、算法、供应商 wire 与组件实现留在插件包内。仓库中的 [Lifecycle Probe](../../tests/third-party/lifecycle-probe/README.md) 和 [Service Provider Probe](../../tests/third-party/service-provider-probe/README.md) 组成可独立安装的双插件样例，覆盖命令、面板、手动函数、数据提交和服务协作。另有 [Jev 选项推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo)。

## 选择通信方式

| 需求                             | 接口                                                      | 执行与数据边界                                                         |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| 消费本轮上游结果                 | `inputs` + `accepts`                                      | 按 capability/runtime 绑定，建立调度依赖，携带来源；必需输入缺失时跳过 |
| 消费已提交的历史结果             | `output.recordAs` + `input.inject` runtime-export         | 读取本次执行开始前的快照                                               |
| 发出事件、触发后续工作           | handler 结果的 events / `emit-event` 工具 + event trigger | 由调度和提交链路管理；不是内存中任意广播                               |
| 调用其他插件的公共函数或模型协议 | `covel.registerService` + `ctx.services`                  | 请求/响应，校验输入输出，只调用活跃且已获准运行的服务                  |
| Runtime 执行领域写入             | 已声明工具、handler effects / `ctx.pluginData`            | 走 runtime 的 proposal/commit 边界，不直接写别的插件                   |
| UI 触发自己的服务端逻辑          | `invokeRuntime` / `invokePluginAction` / `invokeCommand`  | 复用现有 RPC、会话归属与审批；写入边界见下文                           |
| 自由绘制 UI                      | JSON `view` 或 HTML `webview`                             | HTML 在独立 sandbox 中运行，使用消息桥读取数据、发出动作               |

`ctx.services` 当前向 function runtime 开放。Agent 可通过插件自己的 function runtime 取得服务结果，再通过 `inputs` 接收，或继续使用已注册本地工具。它不会自动把全部公共服务暴露给每个 Agent。

UI 的 `invokePluginAction` 调用插件 RPC action，其写入即时生效，handler 后续失败不会自动回滚。多条记录必须一起成功或失败时，用 `invokeRuntime` 触发 `trigger.type: manual` 的 function runtime：`ctx.pluginData` 写入和领域 effects 进入同一次 proposal 提交。该 function handler 不需要 LLM，手动触发本身也不会运行叙事 runtime；声明的事件下游仍按调度契约执行。`invokeCommand` 适用于 manifest 声明的玩家命令，不能用 `invokePluginAction` 绕过命令校验与审计。参见 [RPC 通道](api.md#post-apisessionsidplugin-rpc)与 [handler 写入契约](plugins.md#handler-store-and-commit-ownership)。

插件工具在 `entry` 工厂中通过 `covel.registerTool()` 注册，名字在插件内唯一；不同插件同名不会互相覆盖。工具调用只解析调用方插件的实现和框架内置工具，跨插件公共调用使用下文的 services。

只有 `entry`、Hook 或 UI 的包可以没有 runtime。它的 Hook 仍按会话已启用的插件集合执行，`ctx.getOwnSettings()` 读取包级 `userSettings` 默认值与本次世界、玩家覆盖值；没有 runtime 不会丢失这些默认值，也不会凭空调度一个 runtime。执行与提交各使用明确的会话 Hook scope；嵌入式 `executeTurn` 调用方如需包含零 runtime 包，应在 `TurnExecutorDeps.hookScope` 传入其 `activePluginIds` 和已解析的 `settings`，并在 `commitExecution` 传入相同边界。宿主从持久会话激活集合构造 scope，社区 Hook 每次调用仍检查当前 server-code 授权。

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

entry 在宿主内按插件激活一次，**不属于某个会话**。禁用一个会话中的插件不会销毁其他会话共用的 entry；会话数据仍使用调用上下文和插件数据存储，不放到共享模块闭包中。单次任务使用 `ctx.signal`，需要会话结束通知时使用 `SessionEnd` Hook。此接口依靠插件配合取消和完成清理，不能强制终止忽略信号的 JS，也不提供热卸载或独立后台调度器。

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

- 已支持的模型能力：复用 `ctx.gateway`、`ctx.images`、`ctx.speech`。Evaluation 使用 `ctx.gateway.evaluate({ presetId, state, questions, signal })`，支持 Boolean、Choice、Score。
- 新供应商使用既有 wire：只配置 provider、base URL、模型和用途，无须改插件或框架。
- 新 wire 或新的返回形式：服务内部用 `ctx.gateway.resolveSlot` 取得本次请求的模型配置，再用 `ctx.utils.validateBaseUrl` / `fetchWithRetry` 实现协议，定义自己的输入输出 schema。结果通过服务契约提供给其他插件。密钥只留在服务端，不写入结果、日志或 UI。
- 图片、语音和转写需要复用统一媒体管线时，继续使用 `covel.registerWires`。媒体落库仍通过现有媒体接口。

服务中的 gateway 和 HTTP 工具继承调用 runtime 的请求配置、权限、追踪、取消和撤销边界，不会因为跨插件调用获得更大权限。尤其社区调用方的自管 HTTP 仍受其 `permissions.http` 限制。已提供标准 gateway 方法的能力优先走 gateway。

“无须修改框架”指插件能以自己的契约实现功能。若希望框架的通用模型设置、调度器或媒体系统直接理解一种全新能力类型，仍属于宿主公共契约的演进；服务扩展不会自动给中心能力枚举添加新成员。

## 自定义组件与挂载

插件在 `ui.right` 声明一个 JSON 外壳。`view` 和 `webview` 二选一；不再要求所有业务 UI 都加入框架组件 catalog。

```json
{
  "id": "my-widget",
  "label": { "zh": "我的面板", "en": "My widget" },
  "surfaces": ["panel", "stage"],
  "dataSource": { "namespace": "results" },
  "webview": { "entry": "./widget.html", "height": 280 }
}
```

`surfaces` 缺省为 `panel`；声明 `stage` 后，该面板会挂载在舞台决策区域。这个位置同样支持 JSON `view`。它不检查业务 capability，不了解推荐、骰子、地图或任何具体插件。宿主只提供已有挂载位置；新增一个产品级全局位置仍需要宿主提供。

`webview.entry` 相对 JSON 文件，必须是插件根目录内的 `.html`，真实路径（包括符号链接）不能越界，单文件最多 512 KiB。可使用原生 DOM、Canvas、SVG，或将 React/Vue 等构建成包含脚本和样式的单个 HTML。无需修改 Web 源码或重建框架；插件文件变化后需要重载宿主的插件注册表，开发时通常重启服务端。

HTML 使用 `sandbox="allow-scripts"` 的独立 origin，没有宿主 DOM、cookie、localStorage 或 provider key 访问权。CSP 禁止 fetch 和外部脚本/样式加载，依赖与资源应打包为内联或 data 资源。不要在 HTML 中直接调用 Covel HTTP API。此 UI 沙箱不改变服务端插件代码的信任模型。

宿主注入 `window.covel`：

```js
const unsubscribe = window.covel.subscribe(
  ({ data, locale, locked, context }) => {
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

桥接只接受宿主显式提供的动作：默认是 `invokeRuntime`、`invokePluginAction`、`invokeCommand`，自动绑定当前插件；舞台另提供 `sendMessage({ text })`。不可通过 params 改写 pluginId 来调用其他插件。需要组合其他插件时，从自己的 runtime 使用 `ctx.services` 或事件，不通过浏览器读取对方私有数据。

动作返回现有 RPC 响应；后台 `accepted` 表示任务已接收，不代表完成。桥接通信和调用异常以不含服务端内部详情的错误返回。每个挂载实例独立连接，卸载时关闭；插件不能获取宿主中的任意函数。

## 开发时查看注册与调用

在会话输入 `/plugins` 打开调试页的插件视图，或输入 `/plugins my-plugin` 同时筛选该包及其作为调用方或提供方的服务记录。命令由框架命令目录提供，可搜索、自动补全并走现有 command RPC 校验和追踪，不消耗玩家回合，也不调用 LLM。`/debug` 和 `/trace` 继续打开原调试入口。

插件视图展示安装来源、当前会话的启用与授权状态、runtime ID、实际注册的工具、Hook、RPC action、服务及声明的 slash command。`registered` 只表示命令 action 已注册，实际执行仍检查命令参数、会话和对应 action 的权限。未启用或未授权的包不会展示为当前可用的注册能力。查询只读宿主注册表，不触发 entry、服务发现或插件代码；加载失败和激活失败显示固定状态，具体错误从服务端日志排查。

最近服务调用只保存在当前 server 进程内，全局最多 500 条，每次返回当前会话实例最近 100 条，可按插件筛选。记录调用关系、所属 runtime/turn、耗时、成功/失败/超时/取消与固定错误分类，不记录参数、结果、原始异常或会话私有标识。未取得调用方准入范围的调用不进入会话历史；删除后同 ID 重建的会话无法读取旧记录。重启或请求落到其他进程时不会共享历史，因此该窗口不能用于持久审计或用量统计。未匹配服务的请求使用 `<unavailable>` 标识，超长诊断字符串截断至 256 个 UTF-16 单元并标记 `...[truncated]`。页面支持手动与自动刷新，切换会话会重新查询。

接口见 [插件诊断 API](api.md#get-apisessionsidplugin-diagnostics)。本地组合调试使用 [test-runtime 的 --with-plugin](../guide/plugin-testing.md#coveltest-runtime)，然后用真实 server 验证审批、slash、Hook 和 UI。
