# 01. 系统愿景与设计原则

## 1. 系统目标

covel 不是一个单纯的聊天应用，也不是一个单纯的工作流平台。

它应该是一套面向叙事、世界构建、游戏机制和多模态交互的开放系统。

系统需要同时满足四类需求：

- 内容创作者可以快速构建世界、角色和规则
- 玩家可以在高质量的叙事体验中持续推进长会话
- 扩展开发者可以以 package 的方式接入新能力
- 平台运营方可以在不破坏开源核心的前提下提供托管服务

## 2. 系统定位

下一代系统应被定义为：

- 一个 `内容系统`
- 一个 `会话系统`
- 一个 `扩展平台`
- 一个 `编排平台`
- 一个 `多宿主产品核心`

更进一步说，它应被定义为：

- 一个 `可自部署的 AI 叙事操作系统`

它不应被定义为：

- 一个只有插件能力的聊天 UI
- 一个围绕某个特定模型 API 设计的应用
- 一个围绕某个具体玩法写死的单体系统

## 3. 北极星原则

### 3.1 Open Core First

核心能力必须在开源版中完整存在：

- 世界构建
- 会话推进
- package 运行
- workflow 编排
- prompt graph
- artifact 产出

托管平台只能增加托管价值，不能成为核心功能的唯一承载者。

### 3.2 Package First

系统新增能力的默认方式不是“改核心”，而是“发布一个 package”。

只有真正属于平台根能力的部分，才进入核心。

### 3.3 Contract First

前后端、运行时、平台边界之间的协作必须基于共享契约：

- request
- response
- event
- artifact
- settings
- entity

不接受隐式字符串协议和散落的数据格式。

### 3.4 Flow First

系统的中轴不是页面，也不是 service，而是：

- turn flow
- workflow flow
- job flow
- prompt flow

新增能力必须先考虑放进哪条 flow，而不是先加哪个接口。

### 3.5 Host Agnostic

核心交互逻辑必须尽量不依赖宿主：

- Web
- Electron
- iOS
- Android

宿主差异应通过 shell bridge 隔离。

### 3.6 Platform Boundary

商业化相关能力必须有独立边界：

- auth
- tenant
- usage
- billing
- sync
- hosted providers

不能反向污染内容系统和扩展平台。

### 3.7 Content Native

这个系统的中心不是表单，也不是流程图，而是内容与上下文。

因此系统天然要重视：

- world
- lore
- persona
- memory
- character
- scene
- event
- artifact

## 4. 核心问题抽象

从系统层看，所有未来能力都可以被抽象为下面五种问题。

### 4.1 如何组织世界与会话上下文

也就是：

- 世界文档怎么进入运行时
- 角色、人格、记忆、事件如何进入上下文

### 4.2 如何定义可扩展能力

也就是：

- package 如何安装
- contribution 如何注册
- workflow 如何接入

### 4.3 如何编排处理流

也就是：

- turn 如何运行
- 自动化如何运行
- 后台任务如何运行

### 4.4 如何跨端交付体验

也就是：

- 前端如何消费输出
- 多端如何复用逻辑
- 宿主差异如何隔离

### 4.5 如何承接平台化

也就是：

- token 如何计量
- 套餐如何定义
- hosted provider 如何路由

### 4.6 如何定义统一协议

也就是：

- action 如何表达意图
- event 如何广播状态变化
- artifact 如何被创建和消费
- block 如何统一内容展示与编辑
- context 如何被组装
- capability 如何被注册和调用

## 5. 产品形态边界

这个系统应支持三种产品形态。

### 5.1 Self-host Open Source

特点：

- 可本地部署
- 可自带模型密钥
- 可本地安装 package
- 可无平台账号使用

### 5.2 Official Hosted Platform

特点：

- 注册即用
- 有免费额度
- 有 hosted provider
- 有套餐和账单
- 有跨设备同步

### 5.3 Packaged Clients

特点：

- 同一个核心分别承载在 web、桌面、移动端

这三种形态必须共享同一套核心架构。

## 6. 系统中的一等对象

下一代系统建议明确这些一等对象。

- `Workspace`
- `World`
- `Project`
- `Session`
- `Actor`
- `Persona`
- `Artifact`
- `Package`
- `Workflow`
- `Command`
- `Capability`
- `Entity`

这意味着未来的所有功能都应尽量归入这些对象，而不是创造一堆临时概念。

## 7. 架构风格

整体推荐风格是：

- package-based modular architecture
- contract-first runtime architecture
- event-driven orchestration
- workflow-centered execution
- artifact-aware presentation architecture

这不是传统 MVC，也不是单一 agent architecture。

它更像“内容系统 + 扩展平台 + 编排系统”的融合体。

## 8. 最重要的取舍

为了长期可扩展性，需要接受这些取舍。

### 8.1 不追求最少模块数

模块多一点没关系，边界清楚更重要。

### 8.2 不追求最短实现路径

短期加快一项功能，如果破坏 package 模型，会导致长期维护成本更高。

### 8.3 不追求所有能力都实时

很多能力适合 job + artifact 模型，不必强行实时流式。

### 8.4 不追求插件无限自由

扩展平台的价值来自约束良好的 extension points，而不是任意侵入核心。

### 8.5 不从聊天页面倒推系统

如果系统从聊天 UI 倒推架构，最终会把：

- 世界
- 人格
- 记忆
- workflow
- artifact
- 扩展能力

都压进聊天模块。

正确方向应是：

- 聊天只是默认体验入口
- Narrative Runtime 和 Content Runtime 才是更高层的中心

### 8.6 不把商业对象写进核心领域

例如：

- 套餐
- 账单
- 支付
- entitlement

这些都不能成为核心领域模型的前提条件。

## 9. 最终愿景

理想状态下，covel 应该成为：

- 一个可自部署的叙事游戏平台核心
- 一个可托管的平台产品核心
- 一个可持续扩展的 package 生态底座
- 一个对多模态内容、工作流和多端交付都友好的系统

而这一切的前提是：

从一开始就按系统层级来设计，而不是从某个具体插件倒推架构。
