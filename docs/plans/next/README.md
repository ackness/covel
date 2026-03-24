# 下一代系统设计文档

这组文档从零设计 covel 的下一代系统，不以当前代码结构为前提，也不围绕某个具体插件展开。

目标是定义一个可以长期演进的系统：

- 开源版优先
- 扩展平台优先
- 叙事与机制并重
- 多端可迁移
- 托管平台可后接

## 文档范围

这组文档关注的是系统层级设计：

- 核心对象
- 运行时分层
- 扩展平台
- 上下文与编排
- 前后端宿主架构
- 商业化边界
- 权限、安全与运维
- 分阶段落地路线

这组文档不关注：

- 当前仓库里的类、函数、目录该如何直接改
- 某一个具体插件怎么实现
- 面向当前代码的兼容细节

如果要进入 v1 工程执行，请继续阅读：

- `docs/architecture/specs/*`
  - 这组文档承接本目录的原则判断
  - 负责把“系统愿景”收敛为“可直接实施的执行规范”
  - 不替代白皮书，而是作为实现阶段的工程依据

## 参考方向

这份系统设计重点吸收了几类成熟平台的共性能力：

- `n8n`
  - trigger / action / credential / workflow 平台
- `Dify`
  - 几乎一切插件化、workspace scope、工具/模型/集成统一接入
- `Coze`
  - bot / plugin / token / payment 的平台边界感
- `SillyTavern`
  - prompt pipeline、slash command、world info、persona、extension context
- `VS Code / Backstage / Grafana`
  - contribution points、frontend/backend/common 分层、backend capability 与资源接口

本轮补充里还吸收了一个更高层的判断：

- 这不是“带插件的聊天产品”
- 而应被设计成“可自部署的 AI 叙事操作系统”
- 聊天、世界编辑、artifact 交付、workflow 和多模态能力只是这个系统上的默认体验

## 文档索引

### A. 系统愿景与原则

- `00-system-map.md`
  - 这套系统整体长什么样
  - 核心对象、总线、分层分别是什么
  - 如果只能先读一篇，应该先读什么

- `01-system-vision-and-principles.md`
  - 这个系统到底要成为什么
  - 为什么它不是普通聊天应用，也不是普通工作流平台
  - 什么原则必须长期保持稳定
- `02-domain-runtime-and-lifecycle.md`
  - 系统真正稳定的一等对象是什么
  - 需要哪些 runtime、总线和生命周期
  - 为什么系统中心应是运行时而不是页面或 service
- `03-extension-platform-and-package-model.md`
  - 扩展平台应如何设计
  - 为什么新增能力的默认方式应该是 package
  - package 需要哪些组成、权限、作用域与治理机制
- `04-context-prompt-and-flow-engine.md`
  - 世界、角色、人格、记忆如何进入上下文
  - prompt graph 和 workflow 为什么要一起设计
  - turn flow 和 workflow flow 为什么应该共用一套编排基础
- `05-client-host-and-multidevice-architecture.md`
  - Web、Electron、iOS、Android 应如何共享同一核心
  - 什么该放在 client core，什么该放在 shell bridge
  - package 如何向客户端注入能力而不破坏宿主边界
- `06-platform-boundary-and-commercialization.md`
  - 开源核心和官方托管平台如何共存
  - token 计量、套餐、免费额度、同步该放在哪一层
  - 为什么 billing 不能进入 core runtime
- `07-governance-security-and-observability.md`
  - 扩展生态如何治理
  - 权限、凭据、trace、source trust 如何统一设计
  - 为什么这些不是后补功能，而是系统前提
- `08-delivery-roadmap.md`
  - 这套系统如果真的要落地，应按什么顺序推进
  - 什么应该先做，什么可以延后
  - 怎么判断这套系统是否真正成功

### B. V1 执行规范

这些文档位于：

- `docs/architecture/specs/`

建议先从下面这份入口文档开始：

- `docs/architecture/specs/README.md`
  - 用一页说明 v1 已锁定的决策、实现顺序、day-1 交付范围与非目标

建议按下面顺序阅读：

- `README.md`
  - v1 执行入口与一页决策摘要

- `00-v1-open-core-plan.md`
  - v1 到底做什么，不做什么
  - 技术路线、核心对象与主链路是什么

- `01-runtime-repo-provider-spec.md`
  - monorepo 如何组织
  - runtime、provider、数据库与主协议怎么划边界

- `02-package-command-ui-spec.md`
  - package 如何写
  - slash command、interactive block、schema UI 如何统一

- `03-memory-rag-archive-observability-spec.md`
  - 记忆、RAG、存档、日志与 trace 如何作为 v1 正式能力落地

### C. 重要说明

- `docs/plans/next/*`
  - 定义长期方向、原则和能力全集
- `docs/architecture/specs/*`
  - 定义 v1 的正式开放范围和工程实现边界

如果两者看起来存在“长期能力更大、v1 范围更小”的差异：

- 这是有意设计
- 实现时一律以 `docs/architecture/specs/*` 为直接依据

### C.2 术语说明

为了避免阅读时把长期术语和 v1 执行术语混为一谈，统一采用下面的理解：

- `covel`
  - 项目与产品名
- `Open Core Runtime`
  - 开源核心运行时层
- `Web Host`
  - Web 宿主正式名称
- `apps/web`
  - `Web Host` 的代码目录
- `apps/runtime`
  - `Open Core Runtime` 的主装配目录

- `Extension`
  - 长期架构层的泛化概念
  - 表示系统的扩展能力与扩展点体系
- `Package`
  - v1 执行层的正式安装单位
  - 当文档进入工程实现语境时，优先使用 `Package`
- `Skill`
  - package 内部的行为说明层
  - 在 v1 中主要对应 `SKILL.md`
- `Block`
  - 内容与交互的统一单元
- `Artifact`
  - 可生成、可交付、可预览的结果对象
- `Flow`
  - 执行链语义；v1 只正式实现 `turn / command / resume`

### C.1 工程风格补充

v1 的工程风格明确参考这些现代平台实践：

- `n8n`
  - trigger / action / credential 分离
  - 执行链路可观察
- `Dify`
  - plugin / model / tool / knowledge pipeline 的统一接入
- `Coze`
  - skill-like 作者体验
  - 面向任务推进的 agent 交互

Web Host 的 UI 规范固定为：

- `shadcn/ui`

工具链优先选用现代化、主流、可维护的组合，而不是保守旧栈。

## 一句话架构

covel 应该被设计成：

一个以世界内容和会话体验为中心、以 package 扩展平台为能力组织方式、以 workflow 和 prompt graph 为核心编排层、以多宿主客户端承载交互、以平台边界承接商业化的开放系统。

## 推荐阅读顺序

如果你想先看总貌：

1. `00-system-map.md`
2. `01-system-vision-and-principles.md`
3. `03-extension-platform-and-package-model.md`
4. `docs/architecture/specs/00-v1-open-core-plan.md`

如果你更关心系统如何跑起来：

1. `00-system-map.md`
2. `02-domain-runtime-and-lifecycle.md`
3. `04-context-prompt-and-flow-engine.md`
4. `05-client-host-and-multidevice-architecture.md`
5. `docs/architecture/specs/01-runtime-repo-provider-spec.md`
6. `docs/architecture/specs/03-memory-rag-archive-observability-spec.md`

如果你更关心开源与平台化：

1. `00-system-map.md`
2. `06-platform-boundary-and-commercialization.md`
3. `07-governance-security-and-observability.md`
4. `08-delivery-roadmap.md`

如果你准备直接开始 v1 工程实现：

1. `00-architecture-whitepaper.md`
2. `docs/architecture/specs/README.md`
3. `03-extension-platform-and-package-model.md`
4. `04-context-prompt-and-flow-engine.md`
5. `docs/architecture/specs/00-v1-open-core-plan.md`
6. `docs/architecture/specs/01-runtime-repo-provider-spec.md`
7. `docs/architecture/specs/02-package-command-ui-spec.md`
8. `docs/architecture/specs/03-memory-rag-archive-observability-spec.md`

### D. M1 实施顺序

如果你今天开始实现，请按下面顺序开工：

1. 建立 monorepo 骨架
2. 实现 `contracts + domain + command-system`
3. 实现 `model-gateway + provider registry + profile registry`
4. 实现 `PostgreSQL repository + local artifact store`
5. 实现 `turn flow / command flow / resume flow`
6. 实现 `package runtime`
7. 实现 `memory-rag + archive + observability`
8. 最后实现 Web Host、debug 页面和第一方 packages
