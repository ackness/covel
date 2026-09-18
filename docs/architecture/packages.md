# Workspace package boundaries

`packages/` 当前是工作区内复用边界。各包使用 `workspace:*` 依赖、`private: true` 和 TypeScript 源码入口；它们没有独立 npm 发布、产物资源封装或跨仓库兼容性承诺。评估是否仍在使用时，需要同时检查应用入口、依赖注入和开发命令，不能只统计应用中的 import。

## Consumers and responsibilities

| Package                 | 实际入口 / 消费方                                                  | 复用边界                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ai-provider`           | `apps/server/src/ai-setup.ts`；runtime gateway；test-runtime       | provider、slot、协议与媒体 wire；依赖 shared 契约及模型资源，Node 服务端使用                                               |
| `approval`              | server bootstrap 工具/RPC 审批；runtime tool-executor              | 权限规则与审批门，状态由宿主提供                                                                                           |
| `context`               | runtime 会话上下文与 prompt 组装；server compactor；create prompts | 使用窄 store/LLM 接口；磁盘 prompt loader 仍要求 Node 与 prompts 目录                                                      |
| `create`                | `apps/server/src/routes/api/ai.ts` 的世界生成                      | 可注入 LLM，产出 Covel WorldIR 与插件内容；是领域库而非通用生成器                                                          |
| `events`                | server 订阅与传输；runtime 生命周期；plugin registry               | 事件总线、重放与可选持久化/跨进程 transport；事件契约来自 shared                                                           |
| `memory`                | server bootstrap 注入 runtime，搜索器注入 tools                    | 核心块、提取、recall/archival、向量索引；LLM 和各层 store 均用窄接口                                                       |
| `plugin-handlers-utils` | narrator、scene-cast、world-init、媒体等插件                       | locale、proposal、文本与取消辅助函数；不依赖 runtime/store                                                                 |
| `plugin-loader`         | server 注册/发现；测试工具                                         | Node 文件系统上的插件协议、加载和注册；保留目录与 manifest 约束                                                            |
| `plugin-test-utils`     | 插件测试；test-runtime 的 MockLLM                                  | 开发依赖，提供运行时测试 fixture；不是服务端运行必需组件                                                                   |
| `runtime`               | actions、manual/RPC、resume、detached jobs；test-runtime           | Covel 的调度、执行、proposal 提交和恢复；是集成内核，不是独立的通用 agent-loop 包                                          |
| `settings`              | `apps/web/src/settings/store.ts` 及设置面板                        | 注册、校验、订阅和持久化 adapter；JSON-file backend 接受宿主注入的 IPC/HTTP transport，server 不需再运行一份 SettingsStore |
| `shared`                | 应用、其余库及插件                                                 | 跨层 DTO、schema、领域约束；根入口较宽，特定平台能力应使用已声明 subpath                                                   |
| `store`                 | server 持久化；runtime/memory；web browser-sync                    | Covel 领域记录与多后端实现；浏览器使用专用 subpath，不能把 Node 根入口当作浏览器数据库库                                   |
| `test-runtime`          | 根命令 `pnpm test:runtime`；插件 runtime cases                     | 独立启动真实 runtime 的开发 CLI，支持 mock/live；没有应用 import 也不代表闲置                                              |
| `tools`                 | server 注册；runtime 调用；插件定义工具                            | 工具定义、校验、overlay 和 proposal envelope；注入窄 store 接口，事务提交仍由宿主负责                                      |

## Composition that must stay connected

角色写入经过 `tools` 的会话约束提示与执行校验，生成 proposal，随后由 `runtime` 的提交链写入 `store` 并发布数据更新。工具执行成功不等于已持久化；重复 create 返回已有身份，更新须显式声明。详见 [tools](../reference/tools.md#sync-characters)。

记忆由 server 组装：当前请求 adapter / slot → `memory` updater → DataStore 核心块与面板镜像 → 下一回合 `runtime` → `context` prompt。runtime 的 `memorySystem` 使用结构接口，不直接依赖 memory 包，这是有意保留的可替换边界。普通、manual 和 resume 的已提交叙事均接入提取；未提交结果不触发写入。提取只接收 manifest 声明 `outputKind: story` 的当前回合成功结果，插件内部 text 不是故事事实。宿主统一调用 runtime 的 `commitExecution`；事务、通知、快照、已提交上下文刷新和记忆调度由同一入口衔接，执行结果不携带可调用的收尾回调。恢复执行也使用同一输出导出与媒体校验路径。

`MemoryUpdater.updateAfterTurn` 可携带来源 `turnId` / `traceId` / `modelSlot`；可选 `onUpdate(input, result)` observer 属于同一个 pending 队列，observer 失败不回滚已写入块。队列中的后续任务在前一任务完成后重新加载核心块。应用层负责捕获请求配置、持久化失败状态和显示提示，memory 包不依赖 Hono 或 React。详见 [slots](../reference/slots.md)、[protocol](../reference/protocol.md) 与 [UI panels](../reference/ui-panels.md)。

memory 包保留进程内提取队列；server 为生产链路增加与故事同事务的恢复任务，以及独立的核心记忆锁。PostgreSQL 宿主注入跨进程 advisory lock。最终块、镜像和任务确认一起提交；下一次会话访问补做中断任务。向量索引继续使用独立 ingestion lock；这两种机制不等于所有后台任务都拥有统一事务屏障。详见 [transactions](../reference/transactions.md)。

## Reuse constraints

- `context` 的 `createPromptLoader(root)` 提供独立目录的加载器，可通过 `CompactorDeps.loadPrompt` / `CreateWorldOptions.loadPrompt` 注入；世界生成、重试和 lore 修复使用同一来源。默认 `loadPrompt` / `setPromptsRoot` 仍是进程级兼容入口；并发多目录消费方应使用实例加载器。磁盘加载仍要求 Node，也可注入自定义 `PromptLoader` 函数。
- `events` 只要求 `EventStore.saveEvent` / `getEventById`，不再以 `store` 为生产依赖；现有 DataStore 通过结构类型直接兼容。事件与订阅格式仍是 shared 中的 Covel 协议。
- `shared/plugin-runtime` 是执行契约入口，只导出类型，按服务能力、handler 和已加载 runtime 拆分。runtime 消费契约，loader 生产符合契约的对象；runtime 仅在测试中依赖 loader，旧 loader 类型导出保留兼容。
- `memory` 的 `RecallStore`、`ArchivalStore`、`CoreMemoryStore`、`VectorIngestStore` 只声明实际方法，现有 DataStore 结构兼容。批量核心块更新仍要求同一个事务，不拆散原子性。领域记录类型来自 `store/contracts`；向量能力来自不加载数据库驱动的 `store/vector`，纯能力适配器也可接受检测。
- runtime 的状态、schema、proposal 和调度语义仍属于 Covel；窄接口不等于这些库已与领域协议解耦。
- 作者脚本通过 `ai-provider/config`、`ai-provider/image-wires`、`ai-provider/url-safety` 使用公开入口，根工作区显式声明这些脚本的依赖。`scripts/validate-release-worlds.ts` 仍调用 server 的世界载入入口，属于部署验证工具；未把这个工具专用入口扩大为公共库 API。
- 面向外部发布需要单独定义 API、构建产物、资源与平台入口；在出现该交付需求前，不新增一层只转发现有接口的包装库。

## Boundary checks and remaining tradeoffs

`pnpm check:boundaries` 检查 apps/packages/plugins 生产源码：跨工作区引用必须走公开 exports，生产导入必须声明依赖，packages 的依赖方向必须符合脚本中的显式允许图。语法解析区分 type-only 与运行时导入、注释和动态 import；不把 JSDoc 当作运行依赖。测试 fixture 不受生产依赖方向约束。新增包关系应连同此文档评审后更新允许图。它与 Knip 的未使用依赖检查互补。

- `store/factory` 为数据和媒体选择后端，按需加载；`store/memory`、`store/sqlite`、`store/postgres` 是明确的后端入口。服务端值导入使用 factory/session/errors/capabilities/vector 子入口，测试 CLI 使用 memory。兼容根入口仍导出全部后端，禁止新增生产值导入；本次没有声称或测量启动速度提升。
- `context` 快照只要求 `SessionContextReadStore`，压缩器使用带写入和事务的 `SessionContextStore`；事务视图可以直接构建只读快照。
- `KernelStore` 的领域能力可缺省，但 `working_memory.set` 必须同时具有写入与配额查询能力，不能悄悄跳过数量限制。角色版本写入、plugin-data 与 lore 写入已有缺失能力拒绝路径。
- `plugin-handlers-utils` 根入口保留基础辅助函数；有副作用的完整图片流程经 `/image-generation` 导出。二者保留在同一个包内，避免增加无独立消费需求的包。
- `settings` 的 IPC 环境探测由应用承担。REST 路径默认值仍服务于 Covel 协议，可通过 options 覆盖；没有为跨项目发布增加一层通用传输框架。
- `runtime` 仍是 Covel 的集成内核，调度、递归与提交语义高度关联。本次不按行数机械拆分执行器；是否继续提取阶段模块由实际职责和测试成本决定。
- `shared` 仍承担领域 DTO/schema；世界时间只把声明校验放在 shared，计算、prompt、工具与 UI 放在 core-plugin。没有把时间历法加入内核的逻辑回合计数器。
- `create`、`approval`、`events`、`tools`、`plugin-loader`、`plugin-test-utils` 和 `test-runtime` 都有明确调用方，没有发现应仅因单一消费者或开发用途而删除的依据。

### 插件工具单元测试的状态注入

`plugin-test-utils.bindToolStore` 在每次直接工具调用时复用 runtime 的
`createFunctionStoreView`，绑定当前 session/plugin 并合并已有提案；工具工厂只接收
纯 toolkit。该测试适配器依赖 runtime 实现以及 store/tools 的公开类型，不创建
数据库、不执行提交、不模拟生产审批或取消。包依赖检查明确允许这些开发辅助依赖；
生产 tools/store 仍不反向依赖测试包。
