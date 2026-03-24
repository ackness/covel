# 04. 上下文系统、Prompt Graph 与 Flow Engine

## 1. 核心思想

这个系统的执行，不应围绕“生成一段文本”组织。

它应围绕：

- 构建上下文
- 编排流程
- 交付产物

这意味着 prompt 不是唯一中心，workflow 也不是单独系统，而应共同归入 Flow Engine。

## 2. Context Graph

建议把上下文视为图，而不是单一对象。

主要节点包括：

- world
- lore
- persona
- actor
- scene
- memory
- active events
- recent turns
- package-provided context

Context Graph 的价值是：

- 不同 flow 可按需取用不同上下文子图
- prompt、artifact、automation 不再争抢同一坨 context object

## 2.1 Context Protocol

Context Graph 在运行时中的正式表现应是 `Context Protocol`。

它定义：

- 哪些上下文层存在
- 它们如何被合并
- 哪些层可被 package 提供

## 3. Prompt Graph

Prompt Graph 是 Context Graph 的一种投影。

它负责把上下文编译为模型输入层。

主要 layer：

- system policy
- world framing
- persona
- actor cards
- memory summary
- active scene
- package prompt layers
- tool descriptions

Prompt Graph 不应是模板拼接函数，而应是可预算、可排序、可追踪的 layer graph。

## 3.1 Block Protocol

除了 Prompt Graph，系统还需要 `Block Protocol`。

它定义：

- block 类型
- block schema
- block 嵌套关系
- block renderer key
- block 编辑与交互协议

## 4. 为什么要保留 Prompt Graph

因为叙事系统的核心竞争力之一就是 prompt composition。

参考 SillyTavern，真正成熟的叙事平台都不会把：

- world info
- persona
- summary
- extension prompt
- tool metadata

写成一条简单字符串模板。

## 5. Flow Engine

Flow Engine 是系统中央编排层。

它统一处理：

- conversational turn
- background automation
- artifact generation
- external integration flow

每条 flow 都由：

- trigger
- context resolver
- node graph
- outputs

必要时还应包含：

- permissions
- retries
- approvals
- usage recording

组成。

## 6. Turn Flow

会话回合建议被定义为标准 flow：

1. receive intent
2. resolve context
3. build prompt graph
4. run story model
5. run system capabilities
6. emit state changes
7. emit presentation outputs
8. finalize memory and traces

## 7. Workflow Flow

普通 workflow 与 turn flow 共用同一底层引擎。

区别只在于：

- trigger 来源不同
- node 组合不同

这样系统不会分裂成两套编排模型。

## 8. Trigger 模型

建议系统支持这些 trigger：

- user action
- slash command
- scheduled event
- webhook
- turn lifecycle
- artifact event
- state change

## 9. Node 模型

建议 workflow 节点有标准类型：

- resolve context
- transform data
- ask model
- call capability
- create artifact
- update entity
- emit event
- request user input
- branch
- loop

## 10. 模型角色分工

Flow Engine 不应假设只有一个模型。

建议区分：

- story model
- system model
- specialist model

story model 负责叙事。
system model 负责结构化能力。
specialist model 负责特定任务，如总结、检索、生成多模态内容。

## 11. 记忆与上下文管理

建议将记忆拆成三层：

- factual memory
- narrative summary
- compression summary

三者都来自 flow，但用途不同：

- factual memory 用于事实追踪
- narrative summary 用于叙事连续性
- compression summary 用于上下文预算

## 12. Prompt Budget

Prompt Graph 必须内建预算系统。

每个 layer 都应声明：

- priority
- budget
- trim strategy
- pin policy

否则上下文越多，系统越难控制。

## 13. Flow Outputs

每条 flow 的结果不只是文本。

标准输出应包括：

- state patch
- event
- artifact
- block
- notification
- trace

文本只是其中一种 output。

## 14. 设计结果

把 Context、Prompt 和 Flow 放在同一层考虑后，系统就不会再出现：

- prompt 是一套逻辑
- workflow 是一套逻辑
- artifact 生成又是一套逻辑

这会使整个系统更稳定，也更适合扩展。
