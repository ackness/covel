# 包边界：谁需要知道哪个库

这一页说明 `packages/` 下每个库负责什么、谁在用它。要给框架加一个跨包依赖，或者拿不准一段代码该放进哪个包，先读这一页。写插件的人只需要看第一张表的第一行。

Covel 是模块化单体：一个仓库、一起发布，内部分成若干包。`packages/` 里的包大多只是工作区内部的边界，不单独发布。判断一个库为什么存在，看两点：它负责什么，谁在调用它。

> [!IMPORTANT]
> 唯一面向独立插件作者打包的库是 `@covel/plugin-handlers-utils`。它产出 `dist` 和类型声明文件，工作区内部也从这份 `dist` 读取它。
>
> 所以构建产物比源码旧的时候（例如拉取了新提交却没有重新 `pnpm install`），导入新名字的插件会加载失败。
>
> - 开发服务端每次启动进程时会检查并重新构建（`scripts/ensure-plugin-sdk.mjs`）。
> - Turbo 会先完成 SDK 构建，再运行它自己的 lint 和测试。SDK 测试经 `shared` 读取自己的 `dist` 声明，所以只有依赖包的 `^build` 顺序还不够。
> - 单独运行某个包的测试之前，仍然要手动执行 `pnpm --filter @covel/plugin-handlers-utils build`。

其余的库主要由应用和框架在工作区内组合使用。

## 三条使用路径

| 使用者                           | 应接触的入口                                                                                                                           | 不需要接触的实现                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 插件作者                         | `@covel/plugin-handlers-utils` 的公开 SDK 类型与辅助函数；运行时注入的 `PluginAPI`、`toolkit` 和受限的 `FunctionStoreView`             | `runtime`、`store`、`tools`、`shared` 的内部入口。`tools` 依赖 SDK 并实现宿主侧工具注册与执行，作者经注入的 `toolkit.tool` 定义工具。 |
| 应用宿主（server、desktop、web） | 按职责组合 `plugin-loader`、`runtime`、`store`、`memory`、`approval`、`events`、`context` 等；选择实际后端并提供资源、会话锁及提交策略 | 插件作者的业务逻辑。执行返回值本身不负责持久化，宿主必须提交执行计划。                                                                |
| 框架内部与开发工具               | `shared` 领域契约及各包的内部模块；`plugin-test-utils` 用于插件单元测试，`test-runtime` 用于隔离运行 runtime cases                     | 不应把测试运行器视作完整 HTTP 服务。它与 server 共用默认工具及静态工具审批策略，但 store、LLM、事件目录等资源由测试环境提供。         |

插件作者的 SDK 和宿主的实现是分开的：

- `plugin-handlers-utils` 不依赖任何私有的工作区包。
- `shared` 保存框架各层共用的 DTO 和 schema。
- `tools` 实现 SDK 所描述的工具协议。

详见[插件契约](../reference/plugins.md)和[工具](../reference/tools.md)。

## 每个包的实际责任

| 包                      | 谁需要知道它                                                 | 保留这个边界的理由                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-handlers-utils` | 插件作者、实现作者协议的宿主代码                             | 唯一可独立打包的作者 SDK；拥有 `PluginAPI`、handler/context、proposal、显式工具结果和辅助函数契约。                                                                                                                                                                         |
| `shared`                | 框架包与应用                                                 | Covel 领域记录、事件、schema 和跨层协议的共同类型所有者；不是插件作者的第二套 SDK。                                                                                                                                                                                         |
| `plugin-loader`         | server 与开发测试工具                                        | 从 Node 文件系统发现、校验和加载插件包，保持插件目录及 manifest 协议的单一实现。                                                                                                                                                                                            |
| `runtime`               | server 与 `test-runtime`                                     | 调度、执行、挂起/恢复、效果提交及生命周期组成一个 Covel 内核；宿主通过其执行和提交 API 连接持久化。                                                                                                                                                                         |
| `tools`                 | server、runtime、`test-runtime`                              | 宿主侧工具定义校验、注册、执行和内置工具装配；依赖作者 SDK 的工具结果契约。默认内置集由 `createDefaultToolRegistry` 构造。                                                                                                                                                  |
| `approval`              | server、runtime、`test-runtime`                              | 两种不同授权机制共享一个小包：`createDefaultToolApprovalPipeline` 是工具来源的静态 allow/deny 策略；`createRpcApprovalGate` 是会话范围内交互式 Plugin RPC 授权状态。前者不持久化玩家批准，后者由宿主负责 HTTP 决策流程。                                                    |
| `context`               | runtime、server 压缩/生成流程                                | prompt、历史、插件注入数据和 token budget 的组装。常用入口只有异步 `await buildContext(params)`，按输入自行决定是否读取 store；独立 prompt 目录用 `createPromptLoader(root)` 注入。                                                                                         |
| `events`                | server 订阅层、runtime、插件注册流程                         | Covel 事件总线、重放、可选持久化和 transport 接口；内部 RingBuffer 不属于消费方 API。                                                                                                                                                                                       |
| `store`                 | server、runtime、memory、浏览器同步                          | 领域持久化契约与 Memory/SQLite/PostgreSQL 后端（`/indexeddb` 只提供浏览器侧的媒体缓存）。根入口承载契约、工厂和跨后端操作；具体后端工厂从 `/memory`、`/sqlite`、`/postgres`、`/indexeddb` 导入，浏览器同步和向量能力也有专用子入口。                                        |
| `memory`                | server 装配，runtime 通过注入接口使用                        | recall、archival、BM25/向量检索及增量索引；不配置 embedding 模型时全部走 BM25，排序实现来自 `plugin-handlers-utils` 的 `rankTexts`，插件用的是同一份。每个 `createMemorySystem` 实例拥有自己的后台任务集合、`pendingTaskCount()` 与 `drain()`；宿主停止生产者后排空该实例。 |
| `ai-provider`           | server 的模型配置、runtime gateway、`test-runtime` live 模式 | 模型选择、provider 协议及媒体 wire 的集中适配；具体 provider 不进入插件作者 API。                                                                                                                                                                                           |
| `create`                | server 世界生成路由                                          | 可注入 LLM 的世界内容生成与验证，显式 `writeWorldPackage` 导出文件；数据库消费者直接使用生成结果。                                                                                                                                                                          |
| `settings`              | web 设置面板与持久化 adapter                                 | 设置项注册、校验、订阅和持久化抽象；宿主提供实际 IPC/HTTP transport。                                                                                                                                                                                                       |
| `plugin-test-utils`     | 插件单元与集成测试                                           | 受限上下文、mock，以及复用真实执行和事务提交的工具集成测试入口；不启动完整 HTTP server。                                                                                                                                                                                    |
| `test-runtime`          | 插件开发者运行 runtime cases                                 | 使用隔离 store 与 mock/live gateway 调用真实 runtime 的开发 CLI；复用默认工具集和静态审批策略，但不覆盖 HTTP 路由、生产事件目录或部署锁。                                                                                                                                   |

`approval`、`context`、`events`、`create`、`settings` 这些小包，各自有明确的使用者和独立的责任。

- 不要因为一个包体量小或只在开发时用，就把它并进 `runtime`。
- 也不要为了“看起来通用”而增加只做转发的包。

**依赖方向。** `plugin-handlers-utils` 是依赖图的根，不依赖任何工作区包。`shared` 紧挨在它上面。`@covel/server` 组合所有功能包。精确的依赖边写在各包的 `package.json` 里，`pnpm check:boundaries` 检查公开入口和依赖方向。 SQLite 向量扩展 `sqlite-vec` 由 `store` 直接声明，根包不重复提供。

## 宿主组合的关键边界

宿主指把这些包装配起来运行的应用：server、desktop、web。

### 两个独立的站点

- 官网 `apps/site` 是独立的静态站点。它不依赖任何工作区包，也不进入 Web 或桌面的构建。
- 文档站 `apps/docs` 同样独立。它用 VitePress 把 `docs/` 的页面构建成静态站点，发布在官网的 `docs/` 路径下。
- 文档图表使用 Mermaid 12，需要支持 ES2024 的浏览器（Safari 17.4+）。Mermaid 只属于文档站，不进入 Web 或桌面应用。
- 应用自己的 `/` 直接跳到世界列表。

### 桌面壳

桌面壳直接依赖 Zod 来校验本地保存的窗口状态。窗口的位置和大小属于 Electron 宿主，不作为共享的领域 schema 暴露。

### 执行之后必须提交

一次执行先通过 `executeTurn(...)` 或 `resumeSuspendedRuntime(...)` 得到 `{ result, commit }`：

| 字段     | 是什么                   | 说明                                                                                       |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `result` | 可以传给客户端的业务结果 | 已经去掉各层 runtime result 的 `pendingProposals`。`RuntimeResult.output` 里也只有业务数据 |
| `commit` | 只交给宿主的提交计划     | 包含顶层和递归的结果、journal、suspensions、hook scope、schema、setup 和时钟信息           |

缓冲的写入保留在 `commit.results[].pendingProposals` 里，不藏在 output 上。宿主在会话锁内提交这份计划，不需要自己拼装这些内部数据：

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

- 恢复执行同样把整个 `execution` 交给 `commitExecution`，完成策略选 `kind: "resume"`。
- 提交事务，以及提交之后的通知、快照、记忆调度，分别遵守[事务契约](../reference/transactions.md)。

> [!WARNING]
> 工具调用成功，不代表 proposal 已经保存。只有提交成功才算保存。

### server 和测试运行器共用的部分

server 与 `test-runtime` 都使用 `createDefaultToolRegistry({ store, eventDirectory })` 和 `createDefaultToolApprovalPipeline()`，所以默认工具的名称和来源策略一致。差别在资源：

| 宿主           | 注入什么                                                 |
| -------------- | -------------------------------------------------------- |
| server         | 实际的事件 schema、角色能力、持久化资源和交互式 RPC 审批 |
| `test-runtime` | 隔离的资源和 mock gateway                                |

工具返回 `{ kind: "covel.tool-result", content, pendingProposals, emittedEvents? }` 时，宿主先分离并验证其中的效果，再把正文交给模型。不产生效果的纯工具可以直接返回正文。详见[工具契约](../reference/tools.md)。

### memory 与 create

- memory 统一的 `search` 入口负责复用 query embedding 和跨来源排名。tools 只负责把结果转换成展示的形式。
- `createWorld` 返回经过验证的、可移植的内容。`writeWorldPackage` 负责可选的文件导出。数据库和“仅返回”模式直接使用生成的结果。
- memory 的后台队列属于 `MemorySystem` 实例，不是进程全局的队列。
- 向量增量索引的游标和内容哈希保存在专门的 `vector_index_progress` 表。它是可以重建的派生索引状态，不占用插件数据的命名空间。
- memory 使用 store 的窄能力接口。server 选择 embedding、跨进程锁、恢复任务，以及关闭时的 drain 策略。

详见[事务](../reference/transactions.md)和[世界数据](../reference/world-data.md)。

### context 的 prompt loader

prompt loader 也按实例划分：

- 共享的模板用默认的 `loadPrompt`。
- 另一个模板目录通过 `createPromptLoader(root)` 注入，查找顺序和 `loadPrompt` 相同。插件不用它：插件的模板用 SDK 里的同名加载器，只读 English 和简体中文两份。
- 包的公开入口不导出进程级的 `setPromptsRoot`。
- `buildContext` 统一返回 Promise，调用方不用事先判断走同步还是异步路径。

详见 [prompt 结构](../reference/prompt-structure.md)。

### 作者 SDK 里放了什么

独立的插件 SDK 拥有这些实现，宿主包只是重新导出同一份：

- locale 解析、token 估算、维度的校验与实例化。`@covel/shared` 重新导出这些定义。
- 维度提供者从 `@covel/plugin-handlers-utils/dimensions` 导入。插件不到 shared 包里去取这些操作。
- UI 工具工厂和角色字段校验也在 SDK 里。
- 按 locale 读取文件的功能单独放在只能在 Node 里用的 `/prompts` 入口，根入口保持可以在浏览器里使用。
- 宿主包重新导出的内容包括工具校验的错误类。

## 开发阶段的兼容范围

Covel 还在早期开发，只针对当前的契约。改一个契约时，生产者和消费方一起改，不保留旧入口的别名，也不做双写。现在的规则是：

- 作者使用可打包的 SDK。
- 具体的 store 后端从它的子入口导入。
- 调用 context 必须写 `await buildContext`。
- 宿主必须保留并提交执行计划。
- 工具的效果必须通过显式结果和 `pendingProposals` 传递。
- 测试 fixture 和插件代码按同样的规则更新。

> [!WARNING]
> 这些库目前没有跨版本的持久化迁移承诺。store schema 或向量进度表变化时，受影响的开发数据需要重新创建。不要把“旧数据还能读”或“旧入口还能用”当作保证。

`pnpm check:boundaries` 检查生产源码的三件事：工作区的公开入口、依赖声明、包的方向。需要新的跨包依赖时，连同这一页的责任划分一起评审。

网页端通过 appearance 辅助函数应用 SettingsStore 中的主题和明暗设置，不依赖 `next-themes`。
