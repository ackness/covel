# 08. 分阶段落地路线

## 1. 原则

虽然这组文档从零设计系统，但真正落地时仍应按阶段推进。

每个阶段都应产出独立价值，而不是长期停留在“架构建设”。

## 2. Phase 1：系统骨架

目标：

- 确立 package runtime
- 确立 contract runtime
- 确立 command / workflow / capability / artifact / presentation 这些核心 runtime

价值：

- 未来所有新功能有统一落点

## 3. Phase 2：上下文与编排

目标：

- 完成 context graph
- 完成 prompt graph
- 完成 turn flow 与 workflow runtime 的统一抽象

价值：

- 叙事与机制系统进入统一 flow 模型

## 4. Phase 3：客户端与多模态交付

目标：

- 完成 client contribution registry
- 完成 artifact-native UI
- 建立 shell bridge

价值：

- 为 Web、Electron、移动端复用打基础

## 5. Phase 4：平台边界

目标：

- usage ledger
- provider routing
- auth / tenant boundary
- sync boundary

价值：

- 为 hosted platform 做准备

## 6. Phase 5：生态治理

目标：

- package verification
- signing
- observability
- marketplace foundations

价值：

- 平台能安全承载第三方生态

## 7. 优先级建议

优先顺序建议始终是：

1. 先做核心 runtime
2. 再做 flow 和 artifact
3. 再做 client host
4. 最后接平台边界

而不是一开始先做套餐和支付。

## 8. 需要刻意避免的架构陷阱

### 8.1 把叙事能力写死在聊天模块里

应始终让 Narrative Runtime 高于聊天 UI 存在。

### 8.2 把前端扩展和后端扩展做成两套体系

应始终通过 shared contracts 和 extension bundle 统一。

### 8.3 把 artifact 当附件

artifact 必须是一等公民，否则多模态能力会越来越散。

### 8.4 把 workflow 做成附属高级功能

workflow 实际上应是 Execution Runtime 的中央组织方式。

### 8.5 把 billing 和套餐写进核心领域

平台对象必须挂在 platform boundary，不能渗入 core runtime。

## 9. 成功标准

这套系统落地成功的标准不是文档漂亮，而是：

- 新能力默认以 package 方式接入
- 前后端协作默认走 shared contracts 和标准总线
- turn 和 workflow 共享同一编排基础
- Web、Electron、移动端共用核心交互模型
- 平台化能力不污染开源核心

## 10. 最后结论

这套路线的价值在于：

- 先把系统设计对
- 再逐步把产品做强

这样后面无论增长到什么规模，系统都不会因为早期的局部实现方式而失去扩展性。
