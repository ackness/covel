# 包边界：谁需要知道哪个库

Covel 是模块化单体，`packages/` 大多是工作区内部边界，并非每个包都要独立发布。判断一个库为何存在，要看它拥有的责任和实际调用者。唯一面向独立插件作者打包的库是 `@covel/plugin-handlers-utils`；它产出 `dist` 和声明文件，其余库主要由应用与框架在工作区内组合。

## 三条使用路径

| 使用者                           | 应接触的入口                                                                                                                           | 不需要接触的实现                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 插件作者                         | `@covel/plugin-handlers-utils` 的公开 SDK 类型与辅助函数；运行时注入的 `PluginAPI`、`toolkit` 和受限的 `FunctionStoreView`             | `runtime`、`store`、`tools`、`shared` 的内部入口。`tools` 依赖 SDK 并实现宿主侧工具注册与执行，作者经注入的 `toolkit.tool` 定义工具。 |
| 应用宿主（server、desktop、web） | 按职责组合 `plugin-loader`、`runtime`、`store`、`memory`、`approval`、`events`、`context` 等；选择实际后端并提供资源、会话锁及提交策略 | 插件作者的业务逻辑。执行返回值本身不负责持久化，宿主必须提交执行计划。                                                                |
| 框架内部与开发工具               | `shared` 领域契约及各包的内部模块；`plugin-test-utils` 用于插件单元测试，`test-runtime` 用于隔离运行 runtime cases                     | 不应把测试运行器视作完整 HTTP 服务。它与 server 共用默认工具及静态工具审批策略，但 store、LLM、事件目录等资源由测试环境提供。         |

插件作者的 SDK 与宿主实现分开：`plugin-handlers-utils` 不依赖私有工作区包，`shared` 保留框架跨层 DTO/schema，`tools` 实现 SDK 所描述的工具协议。详见[插件契约](../reference/plugins.md)和[工具](../reference/tools.md)。

## 每个包的实际责任

| 包                      | 谁需要知道它                                                 | 保留这个边界的理由                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin-handlers-utils` | 插件作者、实现作者协议的宿主代码                             | 唯一可独立打包的作者 SDK；拥有 `PluginAPI`、handler/context、proposal、显式工具结果和辅助函数契约。                                                                                                                      |
| `shared`                | 框架包与应用                                                 | Covel 领域记录、事件、schema 和跨层协议的共同类型所有者；不是插件作者的第二套 SDK。                                                                                                                                      |
| `plugin-loader`         | server 与开发测试工具                                        | 从 Node 文件系统发现、校验和加载插件包，保持插件目录及 manifest 协议的单一实现。                                                                                                                                         |
| `runtime`               | server 与 `test-runtime`                                     | 调度、执行、挂起/恢复、效果提交及生命周期组成一个 Covel 内核；宿主通过其执行和提交 API 连接持久化。                                                                                                                      |
| `tools`                 | server、runtime、`test-runtime`                              | 宿主侧工具定义校验、注册、执行和内置工具装配；依赖作者 SDK 的工具结果契约。默认内置集由 `createDefaultToolRegistry` 构造。                                                                                               |
| `approval`              | server、runtime、`test-runtime`                              | 两种不同授权机制共享一个小包：`createDefaultToolApprovalPipeline` 是工具来源的静态 allow/deny 策略；`createRpcApprovalGate` 是会话范围内交互式 Plugin RPC 授权状态。前者不持久化玩家批准，后者由宿主负责 HTTP 决策流程。 |
| `context`               | runtime、server 压缩/生成流程                                | prompt、历史、插件注入数据和 token budget 的组装。常用入口只有异步 `await buildContext(params)`，按输入自行决定是否读取 store；独立 prompt 目录用 `createPromptLoader(root)` 注入。                                      |
| `events`                | server 订阅层、runtime、插件注册流程                         | Covel 事件总线、重放、可选持久化和 transport 接口；内部 RingBuffer 不属于消费方 API。                                                                                                                                    |
| `store`                 | server、runtime、memory、浏览器同步                          | 领域持久化契约与 Memory/SQLite/PostgreSQL/IndexedDB 后端。根入口承载契约、工厂和跨后端操作；具体后端工厂从 `/memory`、`/sqlite`、`/postgres`、`/indexeddb` 导入，浏览器同步和向量能力也有专用子入口。                    |
| `memory`                | server 装配，runtime 通过注入接口使用                        | recall、archival、关键词/向量检索及增量索引。每个 `createMemorySystem` 实例拥有自己的后台任务集合、`pendingTaskCount()` 与 `drain()`；宿主停止生产者后排空该实例。                                                       |
| `ai-provider`           | server 的模型配置、runtime gateway、`test-runtime` live 模式 | 模型选择、provider 协议及媒体 wire 的集中适配；具体 provider 不进入插件作者 API。                                                                                                                                        |
| `create`                | server 世界生成路由                                          | 可注入 LLM 的 Covel 世界内容/WorldIR 生成流程；属于产品领域库，不是通用文本生成器。                                                                                                                                      |
| `settings`              | web 设置面板与持久化 adapter                                 | 设置项注册、校验、订阅和持久化抽象；宿主提供实际 IPC/HTTP transport。                                                                                                                                                    |
| `plugin-test-utils`     | 插件单元测试                                                 | 受限上下文、mock 与工具绑定 fixture，便于直接测试插件；不启动完整 server，也不替代真实提交。                                                                                                                             |
| `test-runtime`          | 插件开发者运行 runtime cases                                 | 使用隔离 store 与 mock/live gateway 调用真实 runtime 的开发 CLI；复用默认工具集和静态审批策略，但不覆盖 HTTP 路由、生产事件目录或部署锁。                                                                                |

这些边界中，`approval`、`context`、`events`、`create`、`settings` 等小包都有明确消费者与独立责任。它们无须仅因体量小或开发用途被并入 `runtime`；也不应为了看起来通用而增加转发包。

## 宿主组合的关键边界

一次执行先通过 `executeTurn(...)` 或 `resumeSuspendedRuntime(...)` 得到 `{ result, commit }`。`result` 是可用于传输的业务结果，已剥离各层 runtime result 的 `pendingProposals`；`RuntimeResult.output` 也只有业务数据。缓冲命令保留在 `commit.results[].pendingProposals` 中，不再藏在 output 上。`commit` 是只交给宿主的计划，包含顶层和递归结果、journal、suspensions、hook scope、schema、setup 与时钟信息。宿主在会话锁内提交它，不再自己拼装这些内部数据：

```ts
const execution = await executeTurn(input, manifests, deps);
const { result } = execution;
await commitExecution({
  execution,
  store: deps.store,
  completion: {
    kind: "turn",
    turnId: result.turnId,
    durationMs: result.durationMs,
  },
});
```

恢复执行同样把整个 `execution` 交给 `commitExecution`，并选用 `kind: "resume"` 的完成策略。提交事务和提交后的通知、快照、记忆调度分别遵守[事务契约](../reference/transactions.md)。工具调用成功也不意味着 proposal 已持久化。

server 与 `test-runtime` 都使用 `createDefaultToolRegistry({ store, eventDirectory })` 和 `createDefaultToolApprovalPipeline()`，因此默认工具名称及来源策略一致。server 仍为会话注入实际事件 schema、角色能力、持久化资源和交互式 RPC 审批；测试运行器使用隔离资源和 mock gateway。工具返回 `{ kind: "covel.tool-result", content, pendingProposals, emittedEvents? }` 时，宿主先分离并验证效果，再把正文交给模型；纯工具可直接返回正文。详见[工具契约](../reference/tools.md)。

memory 的后台队列属于 `MemorySystem` 实例，不是进程全局队列。向量增量索引的游标与内容哈希保存在专门的 `vector_index_progress` 表，属于可重建的派生索引状态，不占插件数据命名空间。memory 使用 store 的窄能力接口；server 选择 embedding、跨进程锁、恢复任务及关闭时的 drain 策略。详见[事务](../reference/transactions.md)和[世界数据](../reference/world-data.md)。

`context` 的 prompt loader 也是实例边界：共享模板可用默认 `loadPrompt`，插件自有目录通过 `createPromptLoader(root)` 注入。包的公开入口不再导出进程级 `setPromptsRoot`。`buildContext` 统一返回 Promise；调用方无需事先判断同步或异步路径。详见[prompt 结构](../reference/prompt-structure.md)。

## 开发阶段的兼容范围

本次调整按当前契约同步更新生产者与消费方，不保留旧版入口的别名或双写：作者应使用可打包 SDK；具体 store 后端应使用其子入口；context 调用须 `await buildContext`；宿主须保留并提交执行计划；工具效果须通过显式结果和 `pendingProposals` 传递。旧测试 fixture 与插件代码也须按同一规则更新。

这些库仍处早期开发，当前没有跨版本持久化迁移承诺。受 store schema 或向量进度表变化影响的既有开发数据需要重新创建；不要把旧数据可读或旧入口可用当作本次改动的保证。`pnpm check:boundaries` 检查生产源码的工作区公开入口、依赖声明与包方向；需要新跨包依赖时，应连同此责任划分一起评审。
