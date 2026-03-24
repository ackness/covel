# 06. 内容包与旧项目迁移说明

## 1. 目的

这份文档补充回答两个 v1 落地中已经出现的真实问题：

- 当前实现和正式规范在哪些点上已经产生语义偏差
- `../ai-gamestudio-dev` 的世界观/预设/角色设定内容，应该按什么路径迁到 `covel`

本文件不是替代 `00-04` 的正式规范，而是把“当前实现现实”和“下一步迁移路径”说清楚，避免工程师误把未来目标当成已完成现状。

## 2. 当前架构判断

### 2.1 `Preset` 的真实归属

当前 `Preset` 主要是运行时基础设施，而不是 package 内容层。

真实落点是：

- `modules/model-gateway`
- `modules/storage`
- `apps/runtime`
- `apps/web`

`extensions/core-presets` 当前只提供一个很薄的 package surface。

结论：

- 如果文档把 `Preset` 描述为“主要由 package 承载”，应优先改文档
- 不应为了对齐文档，把 provider binding 和 runtime preset 强行塞回 package 层

### 2.2 `Worldbook / Persona / Character Card` 的真实状态

这三类能力在架构归属上仍然应该是 first-party packages，但当前实现还处于壳层。

当前现实：

- manifest 已声明 context contribution
- runtime 目前只真正消费 package command
- context provider 还没有接入 `context-graph -> prompt-graph -> flow-engine`

本次已补 manifest 对应的占位模块，目的是让 package 目录结构与声明保持一致，但它们仍不是完整业务实现。

结论：

- 正式规范仍可保留“它们属于 package”这一判断
- 但当前实现文档必须明确标注“尚未接入主链路”

### 2.3 前端设计系统约束

正式规范里把 `shadcn/ui` 写成了硬基线，但当前 Web Host 仍是自定义 React + CSS 最小工作台。

结论：

- 这里更适合改文档，不适合大规模回填代码
- 在当前阶段，`shadcn/ui` 应被视为可选演进方向，而不是必须追补的真实性断言

### 2.4 主链路集成深度

正式规范中的 `ContextGraph / PromptGraph / RetrievalPipeline` 是正确目标，但当前 `FlowEngine` 还没有真正把这些模块装进会话主链路。

结论：

- 这里不应该降文档
- 应保留正式规范为目标态，把差距明确记入当前实现文档

## 3. 冲突处理原则

| 主题 | 当前现实 | 更优处理 |
|---|---|---|
| `Preset` 分层 | 基础设施层为主 | 改文档 |
| package context 执行 | 尚未接主链路 | 改当前状态文档 + 逐步补代码 |
| Web Host `shadcn/ui` 基线 | 还未落地 | 改文档 |
| `ContextGraph / PromptGraph / RAG` 主链路 | 目标正确、实现偏浅 | 保留规范，后续补代码 |
| 旧项目内容迁移 | 内容可迁，执行逻辑不宜直接迁 | 先迁内容资产，再补运行时接线 |

简单说：

- 如果问题是“目标正确，但代码还没做完”，保留规范、补代码
- 如果问题是“规范把未来方向写成当前事实”，优先改文档

## 4. 旧项目内容迁移原则

来自 `../ai-gamestudio-dev` 最值得迁移的不是旧插件执行逻辑，而是：

- 世界模板内容资产
- 世界文档编写规范
- 内容分层方式
- 角色/状态/知识条目的组织经验

当前优先级最高的源内容：

- `templates/worlds/*.md`
- `docs/WORLD-SPEC.md`

补充参考但不直接照搬执行逻辑：

- `plugins/core/state/prompts/*`
- `plugins/narrative/codex/prompts/codex-context.md`

## 5. 当前推荐映射

### 5.1 世界模板

旧世界模板应拆成三层：

- `World`
  - 只承接 `name / description / createdAt` 这类轻元数据
- `Artifact`
  - 保存完整 markdown 原文
- `MemoryDocument`
  - 保存按标题切出的可检索内容块

不要把整篇世界文档塞进 `World.description`。

### 5.2 旧 `plugins`

旧模板里的 `plugins` 不能直接映射成当前 package 列表。

当前只能降级成：

- `legacyPluginHints`
- capability hints
- authoring metadata

### 5.3 DM 指引与玩法触发

这类内容应二次分流：

- 世界规则、地点、势力
  - 归 `worldbook`
- 语气、主持风格、约束
  - 归 `persona`
- 机制触发提示
  - 先保留在 asset / appendix，待 runtime 能力成熟后再结构化

### 5.4 角色卡

当前没有正式 `Actor / CharacterCard` 领域实体。

因此旧角色设定更适合先落成：

- `MemoryDocument(sourceType=character-card)`
- 或 package-owned markdown asset

而不是急着扩张 core domain。

## 6. i18n 相关延后项

下面这些应该等当前 i18n 工作稳定后再继续：

- 模板 metadata 的最终 locale key 形状
- 模板浏览与选择 UI 的双语展示
- prompt-layer 的多语言切换策略

在此之前，可以先迁：

- 原始世界文档
- 轻量 frontmatter
- `legacyPluginHints`

## 7. 当前已落地的迁移入口

本仓库已先把旧项目内容作为 staged assets 放入：

- `extensions/core-worldbook/assets/legacy`

其中包含：

- 一份迁移后的 `WORLD-SPEC`
- 三份代表性世界 seed

这些文件的职责是：

- 给后续 importer 提供稳定输入
- 给 `core-worldbook / core-persona / core-character-card` 提供真实内容样本
- 在不碰 runtime/web/i18n 热区的前提下，先完成内容层迁移
