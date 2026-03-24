# 03. 扩展平台与 Package 模型

## 1. 扩展平台的目标

扩展平台的目标不是“允许加插件”。

真正目标是：

- 让系统新增能力的默认方式是安装 package
- 让 package 可以安全、可验证、可观察地接入系统
- 让 package 同时能贡献前端、后端、工作流、上下文与 artifact 能力

## 2. 为什么要用 Package

Package 是最合适的扩展单位，因为它能同时容纳：

- shared contracts
- frontend contributions
- backend contributions
- workflow nodes
- settings
- credentials
- assets

这比传统的“一个 manifest + 一段脚本”更适合长期平台化。

## 3. Package 的基本组成

每个 package 应包含这些逻辑部分：

- `metadata`
- `permissions`
- `contracts`
- `contributions`
- `runtime hooks`
- `storage bindings`
- `assets`
- `tests`

其中 `contributions` 可以进一步分为：

- prompt
- command
- capability
- workflow
- ui
- artifact
- integration

换一个更工程化的说法，一个成熟的 extension bundle 至少应包含：

- `Manifest`
- `Shared Schema`
- `UI Contribution`
- `Backend Contribution`
- `Runtime Hooks`
- `Storage Binding`
- `Permission Model`

## 4. Shared Contract 是强制层

任何需要前后端共同参与的能力，都必须先定义 shared contract。

包括：

- command input/output
- event payload
- settings schema
- artifact schema
- entity schema

没有 shared contract，就不允许 package 进入正式生态。

## 5. 扩展点模型

系统不应允许 package 任意侵入。

它应只开放标准 extension points。

建议 extension points 包括：

- `PromptLayerProvider`
- `CommandProvider`
- `CapabilityProvider`
- `WorkflowNodeProvider`
- `RendererProvider`
- `PanelProvider`
- `ActionProvider`
- `ArtifactProvider`
- `ResourceProvider`

这和 VS Code 的 contribution points、Backstage 的 extension points 本质一致。

## 6. Package 的作用域

建议 package 明确声明它在哪个 scope 有效。

- platform
- workspace
- project
- session
- user

默认安装和启用应拆开：

- installed
- attached
- enabled

## 7. 权限模型

package 必须声明权限。

推荐权限分类：

- data access
- capability execution
- UI contribution
- host access
- platform access

例如：

- read project
- write session
- outbound http
- run script
- render panel
- use hosted provider

## 8. Credential 模型

参考 n8n，凭据必须是一等概念。

package 不应直接拿到全局密钥。

建议定义：

- credential type
- credential scope
- binding policy
- rotation policy

这样 integrations 和 hosted providers 才能长期可控。

## 8.1 Storage Binding

package 不应自行到处找地方存数据。

建议平台提供标准 storage binding 模型，允许 package 将数据绑定到：

- extension-scoped KV
- document store
- artifact store
- workspace / project / session scoped state

## 9. Package 注册流程

建议统一注册流程：

1. 读取 metadata
2. 校验版本与来源
3. 校验 permissions
4. 注册 contracts
5. 注册 contributions
6. 注册 settings 与 credentials
7. 完成 attach / enable

## 10. Package 生态中的角色

建议生态中的 package 至少分 5 类。

### 10.1 Core Packages

系统基础能力。

### 10.2 Content Packages

世界、角色、persona、memory、codex。

### 10.3 Interaction Packages

guide、forms、UI actions、voice、image。

### 10.4 Integration Packages

外部模型、外部 API、第三方服务。

### 10.5 Platform Packages

sync、billing gateway、marketplace、hosted provider adapter。

## 11. Package 不是代码同义词

Package 可以是：

- mostly declarative
- workflow-driven
- prompt-driven
- UI-heavy
- integration-heavy

代码只是其中一种表达形式。

这能显著降低生态扩展门槛。

## 12. Package 与 Workflow 的关系

package 提供能力，workflow 负责编排能力。

因此 package 应可以贡献：

- workflow nodes
- workflow templates
- workflow triggers

系统级别上，不应该让每个 package 自己偷偷实现一套小型 workflow。

## 12.1 Runtime Hooks

package 还应能声明运行时接入点。

例如：

- `onSessionStart`
- `onBeforePromptBuild`
- `onAfterModelResponse`
- `onArtifactCreated`
- `onMessageRendered`
- `onWorkflowNodeExecute`

## 13. Package 与宿主关系

package 不直接依赖 Web、Electron 或移动端差异。

它只声明：

- 自己需要什么 host capability
- 自己贡献什么 client surface

具体在哪个宿主上怎样落地，由 host runtime 决定。

## 14. Package 生态治理

要让生态长期可维护，建议建立：

- package verification
- package signing
- source trust levels
- permission review
- usage telemetry
- deprecation policy

这部分在开源生态和官方平台生态都很重要。

## 15. 设计结果

当 package 成为系统真正的扩展单位时：

- 新能力不再总是改核心
- 前后端扩展有统一承载
- 商业化和多端也不需要额外分叉能力模型

这才是一个成熟系统该有的扩展平台形态。
