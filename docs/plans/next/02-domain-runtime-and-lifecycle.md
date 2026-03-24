# 02. 领域模型、运行时与生命周期

## 1. 系统中心不是页面，而是运行时

这个系统的核心不应围绕某个页面、某个 API 路由或某个聊天 service 组织。

它应该围绕一组长期稳定的 runtime 组织。

这些 runtime 负责：

- 承载领域对象
- 编排生命周期
- 管理扩展贡献
- 执行 flow
- 交付 artifact

## 2. 领域对象模型

建议领域模型分成四层。

## 2.1 Identity Layer

对象：

- `Workspace`
- `User`
- `Membership`
- `Device`

职责：

- 身份
- 隔离
- 偏好

## 2.2 Content Layer

对象：

- `World`
- `Project`
- `Document`
- `LoreEntry`
- `Persona`
- `Actor`

职责：

- 内容源
- 世界规则
- 角色与人格

## 2.3 Runtime Layer

对象：

- `Session`
- `Scene`
- `Turn`
- `Event`
- `StateSnapshot`
- `MemorySlice`

职责：

- 会话过程
- 状态演化
- 叙事上下文

## 2.4 Output Layer

对象：

- `Artifact`
- `Block`
- `CommandResult`
- `Job`
- `Trace`

职责：

- 结果交付
- 表现层消费
- 审计与观测

## 2.5 八个一等公民

为了避免未来新增能力时概念持续膨胀，建议系统级别固定这 8 个一等公民：

- `Entity`
- `Block`
- `Artifact`
- `Capability`
- `Extension`
- `Context Graph`
- `Job / Workflow`
- `Event`

## 3. 核心运行时

建议系统正式拥有 8 个 runtime。

## 3.1 Package Runtime

负责：

- package 发现
- 安装
- 校验
- 启停
- 依赖解析

## 3.2 Contract Runtime

负责：

- schema 注册
- event 类型注册
- entity 类型注册
- settings 类型注册

## 3.3 Command Runtime

负责：

- 统一接收用户或系统的意图
- 解析参数
- 路由到 capability 或 workflow

## 3.4 Workflow Runtime

负责：

- trigger
- node graph
- retries
- async steps
- approvals

## 3.5 Capability Runtime

负责：

- 模型调用
- 外部服务调用
- 脚本调用
- 内部平台能力调用

## 3.6 State Runtime

负责：

- entity patch
- session state
- snapshots
- projection

## 3.7 Artifact Runtime

负责：

- 文件产物
- 媒体产物
- 版本
- 下载与分发

## 3.8 Presentation Runtime

负责：

- block
- panel
- action
- renderer
- client-visible events

## 3.9 六个产品级子系统

如果从更产品化的视角看，还可以把系统再收敛为 6 个子系统：

- `Narrative Runtime`
- `Content OS`
- `Extension Runtime`
- `Execution Runtime`
- `Client Shell Runtime`
- `Platform Layer`

## 4. 六条总线

所有运行时之间的协作建议通过标准总线完成。

### 4.1 Command Bus

作用：

- 表达意图

### 4.2 Event Bus

作用：

- 广播状态变化和流程事件

### 4.3 Workflow Bus

作用：

- 编排多步执行

### 4.4 Capability Bus

作用：

- 调用执行能力

### 4.5 Artifact Bus

作用：

- 交付产物

### 4.6 State Bus

作用：

- 提交状态变更

## 4.7 六组统一协议

除了总线，系统还应正式定义 6 组统一协议：

- `Action Protocol`
- `Event Protocol`
- `Artifact Protocol`
- `Block Protocol`
- `Context Protocol`
- `Capability Protocol`

## 5. 生命周期模型

建议生命周期有 6 层。

## 5.1 App Lifecycle

- boot
- ready
- shutdown

## 5.2 Workspace Lifecycle

- create
- attach package
- change settings

## 5.3 Project Lifecycle

- create world
- parse content
- resolve package set

## 5.4 Session Lifecycle

- open
- hydrate context
- close
- restore

## 5.5 Turn Lifecycle

- receive input
- build context
- run story flow
- run automation
- finalize

## 5.6 Job Lifecycle

- queued
- running
- progress
- completed
- failed
- cancelled

## 6. 为什么要把 Turn 和 Workflow 视为同等级对象

这点非常关键。

在很多系统中：

- turn flow 是一套逻辑
- workflow 又是一套逻辑

结果会越来越复杂。

更合理的做法是：

- turn 是一种特殊 workflow
- workflow 是更通用的 flow

也就是说，叙事回合只是系统核心 flow 的一种重要实例。

## 7. 状态模型

状态建议分 4 类。

### 7.1 Source of Truth

例如：

- 项目内容
- session 状态
- entity 数据
- artifact 元数据

### 7.2 Derived Projection

例如：

- 当前 prompt view
- scene summary
- quest summary
- codex index

### 7.3 Runtime Ephemeral State

例如：

- 当前正在运行的 job
- 当前播放位置
- 当前表单草稿

### 7.4 Local Client State

例如：

- 展开面板
- 排序方式
- 本地缓存

## 8. Artifact 模型

Artifact 是系统的关键对象，不应被视为文件附件。

建议 artifact 包括：

- 图片
- 音频
- 导出文档
- 视频
- 索引
- 中间结果集

artifact 至少有：

- identity
- type
- owner
- source trace
- storage location
- access policy
- version

## 8.1 Block 模型

和 artifact 同样重要的是 block。

建议 block 被定义为：

- 所有内容展示与编辑的统一最小单元

## 9. 从系统层看“插件”到底是什么

在这个模型里，所谓插件不再是一个孤立后端单元。

它更准确地说是：

- 向多个 runtime 注册 contribution 的 package

所以系统真正扩展的单位不是 service，而是 contribution。

## 10. 设计结果

如果 runtime、总线、生命周期这些层级从一开始就被定义清楚：

- 新功能不会总是落到核心 service 里
- 前后端协作能复用统一模式
- 托管平台边界也更容易独立

这就是后续所有扩展能力成立的基础。
