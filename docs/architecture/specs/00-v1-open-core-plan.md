# 00. V1 Open Core 执行总览

## 1. 文档目的

这份文档不是愿景白皮书，而是 v1 的执行总控文档。

本文件决定：

- v1 的产品边界
- v1 的技术路线
- v1 的核心对象
- v1 的主链路
- v1 的非目标

本文件不决定：

- package 的具体 schema
- 主传输协议的 wire shape
- provider 的实现细节
- RAG 的默认参数

它只回答 5 个问题：

- v1 做什么
- v1 不做什么
- v1 用什么技术路线
- v1 的核心对象是什么
- v1 的主链路怎么跑

详细协议、包模型、RAG、存档、日志与追踪分别写在后续规范中。

## 2. V1 产品边界

v1 固定为：

- 单机自部署
- Web 优先
- Open Core Runtime
- 不依赖 Hosted Platform

相对旧项目的工程约束固定为：

- 完全重构
- 只参考 `../ai-gamestudio-dev` 的能力范围与交互体验
- 不兼容旧代码
- 不兼容旧数据
- 不兼容旧插件

v1 的默认体验是：

1. 写世界
2. 选择或配置第一方内容包
3. 启动会话
4. 通过对话与 `/command` 推进剧情
5. 由 package 输出结构化 block
6. 用户通过 interactive block 回应系统

v1 的主链路是：

- 世界设定 -> 角色/人格 package -> 会话推进 -> interactive block -> block response

## 3. V1 技术结论

v1 技术路线固定为：

- `TypeScript Monorepo`
- `React Web Host`
- `Node Runtime`
- `PostgreSQL`
- `Local Artifact Store`
- `shadcn/ui` design system

前端构建工具基线固定为：

- `Vite 8`

依赖策略固定为：

- 默认使用实现时的最新稳定版依赖
- `package.json` 中使用精确版本号锁定，不使用宽松范围
- 升级策略优先跟进 AI 相关核心库与构建工具，不长期滞后
- 若最新版本引入破坏性问题，只允许回退到最近稳定可用版本，并在 ADR 或变更说明中写明原因

技术原则：

- 优先统一契约，而不是优先拆服务
- 优先统一 provider 抽象，而不是在业务层直接接各家 SDK
- 优先使用一套最小可运行存储组合，而不是一开始引入多种基础设施
- 所有实现遵循奥卡姆剃刀原则：先做最小闭环，再预留扩展点
- 开发方式固定采用 `TDD`
- 默认优先 deterministic tests；真实 LLM 只用于高价值集成验证

### 3.1 参考的现代 agent 工程做法

v1 明确吸收这些现代 agent 平台的工程习惯：

- `n8n`
  - trigger / action / credential 分离
  - 执行记录与可观察性是正式能力，而不是附属调试功能
- `Dify`
  - plugin、model、tool、knowledge pipeline 使用统一接入层
  - 检索与知识处理作为正式系统能力，而不是散落脚本
- `Coze`
  - skill-like 作者体验
  - 面向交付与任务推进的 agent 交互方式

吸收这些做法的目的，是借鉴工程模式，而不是复制它们的产品外形或全部能力范围。

## 4. V1 核心对象

v1 核心对象固定为：

- `World`
- `Session`
- `Message`
- `Command`
- `Block`
- `Artifact`
- `Package`
- `ModelProfile`
- `ArchiveVersion`
- `MemoryDocument`
- `RetrievalRun`
- `TraceRecord`

说明：

- `World`、`Session`、`Command System` 是核心领域的最小根对象
- `CharacterCard`、`Persona`、`WorldBook`、`Preset` 必须实现，但优先作为第一方 package，而不是先写死成核心领域对象
- 这样既支持 RPG，也支持 no-RPG、纯叙事、实验性交互等非传统场景

### 4.1 概念归属表

为避免实现时反复争论“这个概念到底是 core 还是 package”，v1 先固定下面的归属：

| 概念 | V1 归属 | 交付方式 |
|---|---|---|
| `World` | core entity | `modules/domain` |
| `Session` | core entity | `modules/domain` |
| `Command System` | core subsystem | `modules/command-system` |
| `Block` | core protocol | `modules/contracts` + `modules/domain` |
| `Artifact` | core protocol | `modules/contracts` + `modules/domain` |
| `CharacterCard` | first-party package | `extensions/core-character-card` |
| `Persona` | first-party package | `extensions/core-persona` |
| `WorldBook` | first-party package | `extensions/core-worldbook` |
| `Preset` | first-party package | `extensions/core-presets` |
| `Memory / RAG` | core subsystem + first-party package surface | `modules/memory-rag` + `extensions/core-memory-rag` |
| `Archive` | core subsystem + first-party package surface | `modules/archive` + `extensions/core-archive` |

## 5. V1 主链路

v1 会话推进固定为标准 flow：

1. 用户输入普通消息或 `/command`
2. 系统解析为 `ActionCommand`
3. 构建 `ContextGraph`
4. 运行 `RetrievalPipeline`
5. 编译 `PromptGraph`
6. 根据 `ModelProfile` 选择模型
7. 生成文本、block、state patch、artifact、trace
8. 若存在 interactive block，则进入等待状态
9. 用户提交 `BlockResponse`
10. 恢复同一 flow 或派生新的子 flow

关键约束：

- package 向用户提问时，必须输出 interactive block
- 用户响应必须通过结构化 `BlockResponse` 回到系统
- 不允许依赖裸文本问答维持关键状态机

## 6. V1 非目标

v1 明确不做：

- marketplace
- billing
- sync
- tenant / organization
- 官方托管平台
- 任意 workflow 节点开放
- 任意 capability runtime 平台化
- Python 或其他语言的正式 package hook runtime
- 任意前端脚本注入

## 7. V1 成功标准

如果下面这些条件成立，就说明 v1 的架构落地是成功的：

- 只读 `docs/architecture/specs/*` 就可以启动实现
- 世界、会话、命令、package、记忆、存档、追踪都能通过统一语义协作
- package 可以在不修改核心的情况下扩展上下文、命令和交互块
- provider 更换不会改业务层接口
- 记忆、RAG、存档、日志与 trace 都有清晰边界，不依赖临时脚本拼接
- 主界面可优先承载世界编辑与会话推进，复杂观测能力可通过 Langfuse 辅助承载
- 在真实 `openai-compatible` provider 上，最小主链路可通过 live tests 跑通

## 8. 文档关系

本目录中的文档承担“执行级规范”职责。

- `docs/plans/next/*`
  - 继续承担愿景、原则和系统级判断
- `docs/architecture/specs/*`
  - 承担 v1 的工程执行规范

后续实现时，以 `specs/*` 为直接依据，以 `next/*` 为原则约束。

## 9. M1 实施入口

如果一个新工程师今天开始做 v1，建议严格按下面顺序开工：

1. 建立 monorepo 骨架
2. 先写 `contracts + domain + command-system` 的失败测试
3. 再实现 `contracts + domain + command-system`
4. 先写 `model-gateway + provider registry + profile registry` 的失败测试
5. 再实现 `model-gateway + provider registry + profile registry`
6. 再实现 `PostgreSQL repository + local artifact store`
7. 再实现 `turn flow / command flow / resume flow`
8. 再实现 `package runtime`
9. 再实现 `memory-rag + archive + observability`
10. 最后实现 Web host、debug 页面和第一方 packages

M1 首批必须落地的第一方 packages：

- `core-worldbook`
- `core-character-card`
- `core-persona`
- `core-memory-rag`
- `core-archive`
- `core-guide`
- `core-presets`
- `core-debug-commands`

命名约定：

- 产品名统一写作 `covel`
- Web 宿主统一写作 `Web Host`
- 开源核心层统一写作 `Open Core Runtime`
