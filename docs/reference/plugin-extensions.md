# 插件扩展边界与通信

插件通过公开契约组织模型调用、函数与 UI。框架提供发现、授权、调度、校验、取消和挂载；业务数据结构、算法、供应商 wire 与组件实现留在插件包内。参考完整例子：[Jev 选项推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo)。

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
