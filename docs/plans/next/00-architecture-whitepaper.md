# 00. 架构白皮书

## 1. 执行摘要

covel 的下一代系统，不应被定义为一个“带插件的聊天产品”，也不应被定义为一个“套了角色扮演外壳的工作流工具”。

更准确的定义是：

**一个开源优先、可自部署、以世界构建与长会话叙事为核心、以 package 扩展平台为能力组织方式、以 workflow 和 context graph 为中央编排层、以多宿主客户端承载体验、以平台边界承接托管能力的 AI 叙事平台。**

术语说明：

- 本白皮书中的 `extension` 是长期扩展平台语义
- 当进入 v1 执行阶段时，正式安装单位统一收敛为 `Package`
- `Skill` 只表示 package 内部的行为说明层，不等于 package 本身
- 产品名统一写作 `covel`
- Web 宿主统一写作 `Web Host`
- 开源核心层统一写作 `Open Core Runtime`

这套系统要解决的是三类问题：

- 创作者如何构建世界、角色、规则和长期上下文
- 玩家如何在一个连续、可扩展、可多模态的叙事体验中推进会话
- 平台如何在不破坏开源核心的前提下承接托管、计量、套餐、多端和生态

因此，这个系统必须从一开始就具备以下结构特征：

- 内容系统，而不是单纯消息系统
- 运行时系统，而不是页面驱动系统
- 扩展平台，而不是若干离散插件
- artifact 原生，而不是“文本为主、附件为辅”
- host 无关，而不是绑定单一 Web 前端
- platform 可插拔，而不是把商业化对象写进核心领域

## 2. 你要做的产品到底是什么

从产品层面，这个系统应明确回答一句话：

**你要做的是一个让人可以创建、运行、扩展和托管 AI 叙事世界的开放平台。**

它的默认体验是：

- 写世界
- 配角色
- 设人格
- 跑会话
- 接多模态能力
- 用 package 扩展机制

但它的本体不只是“聊天”。

### 2.1 它是什么

它是：

- 一个世界构建平台
- 一个长会话叙事运行时
- 一个 package 扩展平台
- 一个 workflow 编排系统
- 一个多模态 artifact 生成与消费系统
- 一个可被自部署与托管的统一核心

### 2.2 它不是什么

它不是：

- 一个只靠 prompt 拼接的角色聊天页面
- 一个只面向单模型调用的工具
- 一个只能通过改核心代码才能新增能力的应用
- 一个把套餐、支付、账号写进领域模型的闭源 SaaS

## 3. 产品外形：三层式平台

系统在产品形态上应固定成三层。

## 3.1 Open Core Runtime

这是开源版的根，也是整个系统真正的核心。

它必须独立成立，且不依赖官方平台服务。

它负责：

- 世界、角色、人格、记忆、会话
- block / artifact / content system
- context graph / prompt graph
- workflow / job / capability runtime
- package runtime
- 本地或自带密钥的模型接入
- Web / Electron / Mobile 共享协议

### 原则

- 可自部署
- 可自扩展
- 可不登录运行
- 可不接官方服务运行

## 3.2 Hosted Platform Layer

这是未来官方托管版叠加在 Open Core Runtime 之上的平台层。

它负责：

- 账号与组织
- hosted provider
- 免费额度
- token 计量
- 套餐、账单、支付
- 云同步
- 官方扩展市场
- 企业级治理与运营能力

### 原则

- 只增加托管价值
- 不反向污染核心运行时
- 不改变开源核心的基本语义

## 3.3 Experience Shells

这是系统的交付壳：

- Web
- Electron
- iOS
- Android

它们只负责：

- UI 容器
- 宿主能力
- 本地缓存与桥接
- 接入同一套应用协议

### 原则

- 不是多套业务前端
- 是同一运行时的不同壳

## 4. 系统中的一等公民

为了避免未来概念不断膨胀，建议把系统收敛为 8 个一等公民。

## 4.1 Entity

长期存在、可保存、可引用、可版本化的对象。

例如：

- Character
- Persona
- World
- WorldEntry
- Session
- Memory
- Workflow
- Workspace

## 4.2 Block

所有内容展示与编辑的统一最小单元。

它不仅适用于消息，还适用于：

- 世界文档
- 角色资料
- 面板内容
- 扩展输出
- 导出内容的中间表示

## 4.3 Artifact

所有可生成、可交付、可引用、可预览的产物。

例如：

- 图片
- 音频
- PDF / 导出文档
- 总结
- 结构化结果集

artifact 必须是一等公民，而不是附件。

## 4.4 Capability

系统能力的标准注册单位。

例如：

- 文本生成
- 图像生成
- 检索
- rerank
- speech
- export
- workflow invoke

## 4.5 Extension

能力的打包、装配和分发单元。

一个 extension bundle 可以同时带：

- shared schema
- UI contributions
- backend contributions
- hook
- settings
- storage binding

## 4.6 Context Graph

长会话和世界构建的核心抽象。

它不等于 message list，而是：

- 世界
- scene
- persona
- active memory
- retrieved lore
- recent turns
- tool outputs
- package-provided context

Prompt 只是 Context Graph 的一种投影。

## 4.7 Job / Workflow

系统中所有执行图的统一模型。

- 短操作可以直接执行
- 长操作进入 job
- 复杂操作进入 workflow

三者应共享协议、事件和追踪模型。

## 4.8 Event

系统协同的基础对象。

例如：

- session.updated
- artifact.ready
- workflow.completed
- usage.recorded

## 5. 核心运行时架构

系统应围绕 runtime，而不是围绕页面或 service 组织。

建议从产品视角收敛成 6 个大子系统。

## 5.1 Narrative Runtime

这是产品灵魂。

负责：

- 角色
- 人格
- 世界信息
- 长会话
- 记忆
- scene 状态
- 上下文组装
- prompt graph

聊天只是它的一个默认交互面。

## 5.2 Content OS

负责：

- block engine
- document model
- artifact model
- renderer binding
- editor protocol

目的：统一消息、世界文档、面板和导出内容的底层表示。

## 5.3 Extension Runtime

负责：

- package 加载
- contract 注册
- extension points
- permissions
- credentials
- hook 执行

它是平台内核，不是附属模块。

## 5.4 Execution Runtime

负责：

- action 执行
- capability 调用
- job queue
- workflow engine
- 调度与重试

所有异步任务、后台任务、自动化任务都应进入这一层。

## 5.5 Client Shell Runtime

负责：

- client contribution registry
- local interaction state
- artifact rendering
- shell bridge
- event consumption

它让 Web、Electron、Mobile 可以共用同一套交互逻辑。

## 5.6 Platform Layer

负责：

- account
- organization
- billing
- usage
- payment
- sync
- hosted providers

它只附着在核心之上，不反向定义核心领域。

## 6. 统一协议模型

这套系统是否会持续清晰，关键不在 service 拆分，而在协议是否统一。

建议从一开始就定义 6 组统一协议。

## 6.1 Action Protocol

表达“用户或系统想做什么”。

例如：

- send_message
- run_workflow
- create_artifact
- update_world_entry
- open_panel

## 6.2 Event Protocol

表达“系统发生了什么”。

例如：

- message.stream.delta
- session.updated
- artifact.ready
- job.progress

## 6.3 Artifact Protocol

定义 artifact 如何被创建、存储、预览、引用和下载。

至少应包含：

- type
- schema version
- storage locator
- renderer key
- provenance
- permission
- version

## 6.4 Block Protocol

定义内容如何被渲染、编辑、嵌套和交互。

block 应成为前台内容系统的统一原语。

## 6.5 Context Protocol

定义上下文的层、组装规则和消费方式。

建议基础分层包括：

- session layer
- narrative layer
- memory layer
- world layer
- retrieval layer
- tool-output layer
- user-preference layer

## 6.6 Capability Protocol

定义扩展如何声明能力，以及系统如何调用这些能力。

它是模型、工具、集成、生成器等能力的统一接入口。

## 7. 扩展平台模型

系统新增能力的默认方式应是安装 package，而不是改核心。

一个成熟的 extension bundle 至少应包括：

- Manifest
- Shared Schema
- UI Contribution
- Backend Contribution
- Runtime Hooks
- Storage Binding
- Permission Model

### 7.1 为什么必须这样

因为“前后端都要参与”的能力不是特例，而是默认情况。

未来无论是：

- 语音
- 图像
- 导出
- 检索
- 云同步
- 协作

都应走同一个 extension 模式。

### 7.2 Package 的核心能力

package 至少应能贡献：

- prompt layers
- commands
- capabilities
- workflow nodes
- panels
- actions
- renderers
- artifact types
- resource endpoints

重要说明：

- 这里描述的是系统长期能力全集
- 不代表 v1 必须把这些能力全部开放给 package
- v1 的正式开放范围，以 `docs/architecture/specs/02-package-command-ui-spec.md` 为准

## 8. 多端与宿主模型

从一开始就要按“headless core + shells”思路收敛。

### 8.1 Web

作为主控制台，提供最完整的创作与运行体验。

### 8.2 Electron

作为桌面壳，增加：

- 本地文件
- 本地缓存
- 桌面通知
- 原生桥接

### 8.3 iOS / Android

作为移动壳，优先承载：

- 会话体验
- artifact 消费
- 轻量编辑

### 8.4 共同原则

- 业务协议共享
- UI 能力共享
- 宿主差异通过 shell bridge 隔离

## 9. 商业化边界

商业化必须建立在平台边界上，而不是写进核心领域。

### 9.1 Open Core 必须独立成立

开源核心应完整支持：

- content system
- session system
- package runtime
- workflow runtime
- artifact runtime
- BYOK provider

### 9.2 Hosted Platform 只负责附加价值

包括：

- hosted provider
- usage ledger
- free quota
- plans
- credits
- billing
- sync
- marketplace

### 9.3 平台对象

平台层对象建议包括：

- Account
- Organization
- Membership
- Plan
- Subscription
- Entitlement
- UsageEvent
- BillingLedger
- Payment
- Invoice

这些对象不应成为核心运行时的前置条件。

## 10. 分阶段落地原则

系统落地建议始终遵循这个顺序：

1. 先立统一语义层
2. 再立核心 runtime
3. 再立 flow 和 artifact
4. 再立 client host
5. 最后接平台边界

而不是一开始先做套餐和支付。

## 11. 必须规避的架构陷阱

### 11.1 把叙事能力写死在聊天模块里

应始终让 Narrative Runtime 高于聊天 UI 存在。

### 11.2 把前端扩展和后端扩展做成两套体系

应统一到 extension bundle 和 shared contracts。

### 11.3 把 artifact 当成附件

artifact 必须是一等公民。

### 11.4 把 workflow 做成附属高级功能

workflow 实际上应是 Execution Runtime 的中央组织方式。

### 11.5 把 billing 和套餐写进核心领域

所有商业对象必须停留在 platform boundary。

## 12. 最终结论

你要做的系统，本质上不是：

“一个角色扮演产品，后来再加插件、商业化和多端。”

而应该是：

**一个开源可自部署的 AI 叙事平台内核，角色扮演是默认体验，package 是扩展单位，workflow 是执行引擎，artifact 是统一产物，平台化是外挂边界，多端是交付外壳。**

只要这个定义成立，后面的：

- 托管平台
- token 计量
- 套餐收费
- 多模态能力
- 扩展市场
- Electron
- 移动端

都能在同一套系统之上自然生长。
