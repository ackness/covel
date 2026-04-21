# 插件 UI 与交互运行时指南

这份文档总结 Covel 当前插件 UI 与交互的推荐做法，并先明确最重要的架构原则：

- **Covel 框架是独立的 Agent 编排框架。**
- **插件包是功能与体验的完整承载单元。**
- **插件适配优先在插件包内完成。**
- **大型框架改动先确认，再进入实现。**

适用范围：

- 右侧面板 `ui.right`
- 聊天流内插件消息面 `ui.message`
- 通用表单 / 选项提交协议
- 插件数据写入与前端渲染联动

---

## 1. 架构原则

### 1.1 框架定位

Covel 框架承担的是 **Agent 编排层**。

它的职责是：

- 加载插件 manifest、prompt、tools、UI spec
- 调度 runtime 执行顺序
- 管理 session、turn、phase、SSE、snapshot
- 提供通用数据通道：`plugin_data`、`turn_messages`、`session state`
- 提供通用 UI 基础组件：`Card`、`Text`、`Row`、`Grid`、`Badge`、`Button`、`Input`、`GraphCanvas`

这层能力对所有插件都成立，它服务的是“插件生态的运行”，而不是某一个具体插件。

### 1.2 插件定位

插件包承担的是 **功能、数据结构、交互与 UI 体验的完整适配层**。

一个插件包内优先承载：

- 功能逻辑
- 提示词
- 本地工具
- `plugin_data` 结构
- `ui.message / ui.right / ui.left`
- 插件自己的文案、布局、动作设计

这条原则意味着：

- guide 的建议样式属于 `core-guide`
- codex 的摘要与图鉴属于 `core-codex`
- 关系图谱的命名、面板说明、节点呈现属于 `core-npc-graph`

### 1.3 适配位置

插件适配优先放在插件包内完成。

推荐顺序：

1. 先改插件自己的 prompt / tool / handler
2. 再改插件自己的 `ui/*.json`
3. 再改插件自己的 `plugin_data` 结构
4. 最后才评估是否需要新增框架级原语

这条顺序可以保证：

- 框架保持稳定
- 插件保持独立演进
- UI 风格、交互策略、数据组织都由插件自己负责

### 1.4 框架变更门槛

大型框架改动先确认，再进入实现。

这里的“大型框架改动”包括：

- 新的通用协议
- 新的 store 表 / 全局 schema
- 新的 runtime 生命周期语义
- 新的全局 UI slot / 渲染原语
- 对所有插件都会生效的行为变化

这类改动的工作流是：

1. 先说明为什么需要升级到框架层
2. 说明对现有插件的影响范围
3. 说明插件内适配方案为什么已经不够
4. 获得确认后再改框架

### 1.5 工具调用方向

Covel 当前的工具层分成两类：

- `tools.builtin`：框架提供的通用 building blocks
- `tools.local`：插件自己声明、自己维护、自己测试的本地工具

推荐选择顺序：

1. 通用、重复、跨插件复用的操作，直接复用 builtin
2. 插件专属的数据 schema、批量写入、RAG 检索、图谱维护、图鉴整理，定义 local tool
3. 多个插件长期复用且契约稳定的能力，再提案升级为框架级 builtin

当前代码状态：

- `apps/server/src/routes/api/bootstrap.ts` 会统一注册 builtin 工具
- trusted 插件声明的 local tool 会按 manifest 自动加载
- local tool 访问权限按 `pluginId` 隔离，调用方只能访问自己声明的 local tool
- local tool 与 deterministic handler 当前可以使用注入的 `store` 完成插件包内批量写入

### 1.6 插件工具目录归属

插件自己的工具保持在插件目录内组织。

推荐位置：

- `plugins/<plugin-id>/tools/*.js`
- `plugins/<plugin-id>/runtimes/<runtime-id>/tools/*.js`

声明方式：

- 在 `PLUGIN.md` 里通过 `tools.local` 写相对路径
- 路径解析以插件根目录为基准

当前框架会校验路径边界，确保工具文件位于插件包目录内。

### 1.7 插件测试要求

每个插件至少覆盖四类测试：

1. manifest / runtime 能被框架发现并正确加载
2. local tool 的参数 schema、持久化写入、返回结构符合预期
3. handler 或 agent runtime 的核心输出形状稳定
4. `plugin_data` 与 `ui.message / ui.right` 的契约稳定

当前 core 插件已经有这类样例：

- `plugins/core-codex/tests/codex.test.js`
- `plugins/core-npc-graph/tests/npc-graph.test.js`
- `packages/runtime/tests/session-kernel.test.ts`

---

## 2. 基本边界

### 2.1 框架负责什么

框架负责：

- 通用编排
- 通用状态与数据通道
- 通用基础组件
- 通用交互协议

### 2.2 插件负责什么

插件负责：

- 功能定义
- 体验设计
- 交互细节
- 业务数据组织
- 插件 UI

### 2.3 当前推荐实践

当前开发里优先采用这条判断：

- 能在插件包内解决的事情，优先放在插件包内解决
- 需要跨插件复用、稳定长期存在、能形成通用原语的事情，再进入框架层

---

## 2. 三条 UI 通道

### 2.1 主叙事流

主叙事流来自 runtime 的 `outputKind: story`。

用途：

- narrator 主剧情
- 玩家输入
- 少量必须进入主时间线的叙事文本

推荐：

- 叙事层只放真正需要玩家阅读的文本
- 初始化提示、后台跟踪摘要、结构化建议优先放到 `system` 或插件自己的 `ui.message`

### 2.2 插件消息面 `ui.message`

`ui.message` 适合高频、轻量、结构化的聊天内插件 UI。

用途：

- guide 建议卡
- codex 本轮新增术语摘要
- 小型任务卡、风险提示卡、投票卡、局部操作卡

推荐：

- 内容短
- 信息密度高
- 细节摘要克制
- 详情跳转或引导用户去右侧 panel 深看

### 2.3 插件侧栏 `ui.right`

`ui.right` 适合持续存在、可浏览、信息更完整的插件面板。

用途：

- 角色面板
- 图鉴
- 关系图谱
- 世界维度

推荐：

- 用它承接 message 面中被压缩掉的细节
- 面板命名直接反映数据模型
- 例如 `人物图谱` 改成 `关系图谱`，更贴合“角色 / 群体 / 势力关系”

---

## 3. 数据通路

### 3.1 推荐写法

插件 runtime / tool 先写 `plugin_data`，前端再通过 `ui spec` 消费。

推荐命名：

- `entries`：稳定词条 / 实体数据
- `message`：聊天内临时摘要数据
- `nodes / edges / index`：图谱类数据

### 3.2 典型链路

#### Guide

1. runtime 分析 narrator 输出
2. tool 生成三类建议
3. tool 把 `topic`、`category1Label`、`category1Suggestion1` 等写入 `plugin_data[core-guide][message]`
4. `plugins/core-guide/ui/action-guide-block.json` 从 `message` namespace 读取并渲染

#### Codex

1. runtime 从 narrator 文本提取术语
2. handler 把完整词条写入 `plugin_data[core-codex][entries]`
3. 同时把本轮摘要写入 `plugin_data[core-codex][message]`
4. `ui.message` 只显示关键词摘要
5. `ui.right` 显示完整图鉴

---

## 4. 交互协议

### 4.1 通用 `interaction.request`

框架提供通用交互协议：

- `form`
- `choice`
- `confirmation`

这些协议适合：

- 角色创建
- 多步确认
- 结构化输入

### 4.2 `submitBehavior`

交互块可以声明通用提交行为：

```ts
submitBehavior: {
  echoFilledNarrative?: boolean
  immediate?: boolean
}
```

字段语义：

- `echoFilledNarrative`（默认 `true`）：把填充后的叙事作为玩家气泡回显到聊天流。设为 `false` 时只用作下一轮的隐藏输入，不出现在对话里。
- `immediate`：玩家提交后立即关闭表单并继续执行。

这条协议是框架级能力，不绑定任何具体插件。

### 4.3 聚合发送

当前推荐体验：

- 插件建议点击后进入“待发送区”
- 玩家可以继续补充自定义输入
- 底部发送按钮一次性把建议草稿 + 手写说明一起发出

这套机制适合未来更多插件同时出现：

- guide 选择
- 任务确认
- 道具选择
- 小型表单输入

### 4.4 玩家选择回放（自动）

任何走 `draftMessage` / `selectChoice` / `selectSuggestion` 进入"待发送区"的交互，
框架会在玩家点击底部发送时自动：

1. 将每个 draft 按 `sourceBlockId`（即原 `StreamMessage.id`）汇总；
2. 调用内部 `submitBlock(sourceBlockId, { _kind: "selection", _label, items })`，把选择持久化到 IDB（`submittedBlockValues` 表）；
3. 重新渲染该 block 时，框架追加一行 `你的选择：xxx` 的 `SubmittedSelectionFooter`。

`form` 类提交（`submitForm` → `submitInteraction`）走另一条路径：原始字段值已经直接烘焙进 disabled 表单 spec，所以框架**不会**再额外渲染 footer。

插件作者无需特殊适配——只要按 [`core-guide/ui/action-guide-block.json`](../../plugins/core-guide/ui/action-guide-block.json) 的方式使用 `draftMessage` 等动作，玩家选择就会被自动记录与回放。

---

## 5. Message UI 设计建议

### 5.1 Guide

推荐结构：

- 顶部一张主题卡
- 中间 3 组策略卡
- 每组 1-3 条建议按钮
- 底部或右下角一个自定义行动输入区

推荐约束：

- 三类建议足够稳定
- 每类建议数保持 1-3
- 词句直接可执行

### 5.2 Codex

推荐结构：

- 聊天流里只给“本轮新增术语摘要”
- 右侧图鉴保留完整内容

推荐摘要内容：

- 术语标题
- 类型 badge

推荐详细内容存放位置：

- `ui.right` 图鉴面板

---

## 6. 图鉴抽取建议

### 6.1 记录什么

推荐记录：

- 地点
- 物件
- 世界设定
- 技法 / 阵法 / 术式

### 6.2 内容写法

推荐写成术语解释体：

- `百灵沼泽：当前剧情中的关键地点，与眼前事件直接相关。`
- `佩剑：当前剧情里明确出现的物件，可作为线索或行动资源。`

这类内容适合图鉴。

### 6.3 聊天内摘要

聊天内摘要只列新增术语标题即可。

完整解释放右侧图鉴。

---

## 7. 图谱边界

### 7.1 当前图谱适合什么

当前 `core-npc-graph` 模型适合：

- 个人 `individual`
- 群体 `group`
- 势力 `faction`

以及它们之间的关系边。

### 7.2 当前图谱不承担什么

术语表、地点百科、物件百科更适合放在 codex。

这意味着：

- `codex = 术语 / 词条 / 世界知识`
- `graph = 角色 / 群体 / 势力关系`

后续如果需要“世界图谱”，推荐新建独立数据模型，而不是直接把 codex 条目塞进 NPC 图谱。

---

## 8. UI Spec 编写建议

### 8.1 推荐

- 小而稳定的 message 面优先用固定字段
- 高频 UI 优先用浅层数据结构
- `ui.message` 与 `ui.right` 分开设计
- `emptyState` 永远提供清晰说明

### 8.2 当前经验

对于高频消息面：

- 直接写 `topic`
- `category1Label`
- `category1Suggestion1`
- `item1Title`
- `item1Category`

这类固定字段最稳定。

对于右侧面板：

- 使用 `repeat.statePath`
- 数据结构可以更完整

### 8.3 热更新

当前 `/api/ui-specs` 已经改成按请求同步最新插件 UI spec 到 store，再从 store 返回。

效果：

- 修改插件 `ui/*.json`
- 刷新页面
- 前端拿到最新 spec

---

## 9. Session 起始流程建议

推荐默认插件集：

- `core-pregame`
- `core-world-init`
- `core-narrator`
- `core-char-creator`

扩展插件建议手动启用：

- `core-guide`
- `core-codex`
- `core-npc-graph/extractor`

这样起始体验更干净：

1. 世界选择
2. Session prep
3. 角色创建
4. 自动进入 `playing`
5. narrator 自动给开场场景
6. 其他插件按需补充

---

## 10. 给插件作者的直接建议

如果你正在写一个新插件：

1. 先决定信息属于 `story`、`ui.message` 还是 `ui.right`
2. 先设计 `plugin_data` 结构，再设计 spec
3. 聊天面只放摘要和动作
4. 右侧面放详情和浏览
5. 表单 / 选择 / 确认优先用框架通用协议
6. 样式放在插件自己的 spec 里完成，框架只补通用基础组件变体

这套方式最符合 Covel 的基本原则：**框架编排，插件定义体验。**
