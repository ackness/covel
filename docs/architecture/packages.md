# Workspace package boundaries

`packages/` 当前是工作区内复用边界。各包使用 `workspace:*` 依赖、`private: true` 和 TypeScript 源码入口；它们没有独立 npm 发布、产物资源封装或跨仓库兼容性承诺。评估是否仍在使用时，需要同时检查应用入口、依赖注入和开发命令，不能只统计应用中的 import。

## Consumers and responsibilities

| Package                 | 实际入口 / 消费方                                                  | 复用边界                                                                                                 |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ai-provider`           | `apps/server/src/ai-setup.ts`；runtime gateway；test-runtime       | provider、slot、协议与媒体 wire；依赖 shared 契约及模型资源，Node 服务端使用                             |
| `approval`              | server bootstrap 工具/RPC 审批；runtime tool-executor              | 权限规则与审批门，状态由宿主提供                                                                         |
| `context`               | runtime 会话上下文与 prompt 组装；server compactor；create prompts | 使用窄 store/LLM 接口；磁盘 prompt loader 仍要求 Node 与 prompts 目录                                    |
| `create`                | `apps/server/src/routes/api/ai.ts` 的世界生成                      | 可注入 LLM，产出 Covel WorldIR 与插件内容；是领域库而非通用生成器                                        |
| `events`                | server 订阅与传输；runtime 生命周期；plugin registry               | 事件总线、重放与可选持久化/跨进程 transport；事件契约来自 shared                                         |
| `memory`                | server bootstrap 注入 runtime，搜索器注入 tools                    | 核心块、提取、recall/archival、向量索引；LLM 用窄接口，存储仍依赖 Covel DataStore                        |
| `plugin-handlers-utils` | narrator、scene-cast、world-init、媒体等插件                       | locale、proposal、文本与取消辅助函数；不依赖 runtime/store                                               |
| `plugin-loader`         | server 注册/发现；runtime manifest/hook 类型；测试工具             | Node 文件系统上的插件协议、加载和注册；保留目录与 manifest 约束                                          |
| `plugin-test-utils`     | 插件测试；test-runtime 的 MockLLM                                  | 开发依赖，提供运行时测试 fixture；不是服务端运行必需组件                                                 |
| `runtime`               | actions、manual/RPC、resume、detached jobs；test-runtime           | Covel 的调度、执行、proposal 提交和恢复；是集成内核，不是独立的通用 agent-loop 包                        |
| `settings`              | `apps/web/src/settings/store.ts` 及设置面板                        | 注册、校验、订阅和持久化 adapter；JSON-file backend 经宿主 HTTP API，server 不需再运行一份 SettingsStore |
| `shared`                | 应用、其余库及插件                                                 | 跨层 DTO、schema、领域约束；根入口较宽，特定平台能力应使用已声明 subpath                                 |
| `store`                 | server 持久化；runtime/memory；web browser-sync                    | Covel 领域记录与多后端实现；浏览器使用专用 subpath，不能把 Node 根入口当作浏览器数据库库                 |
| `test-runtime`          | 根命令 `pnpm test:runtime`；插件 runtime cases                     | 独立启动真实 runtime 的开发 CLI，支持 mock/live；没有应用 import 也不代表闲置                            |
| `tools`                 | server 注册；runtime 调用；插件定义工具                            | 工具定义、校验、overlay 和 proposal envelope；注入窄 store 接口，事务提交仍由宿主负责                    |

## Composition that must stay connected

角色写入经过 `tools` 的会话约束提示与执行校验，生成 proposal，随后由 `runtime` 的提交链写入 `store` 并发布数据更新。工具执行成功不等于已持久化；重复 create 返回已有身份，更新须显式声明。详见 [tools](../reference/tools.md#sync-characters)。

记忆由 server 组装：当前请求 adapter / slot → `memory` updater → DataStore 核心块与面板镜像 → 下一回合 `runtime` → `context` prompt。runtime 的 `memorySystem` 使用结构接口，不直接依赖 memory 包，这是有意保留的可替换边界。普通、manual 和 resume 的已提交叙事均接入提取；未提交结果不触发写入。提取只接收 manifest 声明 `outputKind: story` 的当前回合成功结果，插件内部 text 不是故事事实。外部 commit owner 可通过 runtime 的 `schedulePostTurnMemoryUpdate` 接入相同逻辑，必须在提交成功后提供 runtime manifest、当前记忆块与会话上下文。

`MemoryUpdater.updateAfterTurn` 可携带来源 `turnId` / `traceId` / `modelSlot`；可选 `onUpdate(input, result)` observer 属于同一个 pending 队列，observer 失败不回滚已写入块。队列中的后续任务在前一任务完成后重新加载核心块。应用层负责捕获请求配置、持久化失败状态和显示提示，memory 包不依赖 Hono 或 React。详见 [slots](../reference/slots.md)、[protocol](../reference/protocol.md) 与 [UI panels](../reference/ui-panels.md)。

当前核心记忆 pending 队列是进程内的；它与向量索引的跨进程 ingestion lock 是不同机制。本地会话修改会等待核心记忆任务，不能据此推导 PostgreSQL 多进程部署中所有后台派生写入都获得了统一事务屏障。

## Reuse constraints

- `context` 的 `createPromptLoader(root)` 提供独立目录的加载器，可通过 `CompactorDeps.loadPrompt` / `CreateWorldOptions.loadPrompt` 注入；世界生成、重试和 lore 修复使用同一来源。默认 `loadPrompt` / `setPromptsRoot` 仍是进程级兼容入口；并发多目录消费方应使用实例加载器。磁盘加载仍要求 Node，也可注入自定义 `PromptLoader` 函数。
- `events` 只要求 `EventStore.saveEvent` / `getEventById`，不再以 `store` 为生产依赖；现有 DataStore 通过结构类型直接兼容。事件与订阅格式仍是 shared 中的 Covel 协议。
- `memory` 保留 DataStore 类型耦合；runtime 的状态、schema、proposal 和调度语义属于 Covel。拆分文件夹不等于这些库已与领域协议解耦。
- `scripts/lib/image-gen-common.mjs` 仍深导入 ai-provider 的内部配置/HTTP/wire 文件。这是开发脚本的内部路径耦合，修改这些路径时必须检查该消费方。
- 面向外部发布需要单独定义 API、构建产物、资源与平台入口；在出现该交付需求前，不新增一层只转发现有接口的包装库。
