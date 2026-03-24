# 02. Package、命令与交互 UI 规范

## 1. 目标

本规范定义 v1 的 package 模型、skill-like 作者体验、slash command 系统，以及 interactive block 协议。

本文件决定：

- package 的目录结构
- manifest 的最小形状
- `SKILL.md` 的职责
- package v1 允许和禁止的贡献范围
- slash command 的基础规则
- block / response 的最小协议
- schema UI 与 custom renderer 的边界

本文件不决定：

- runtime 与 provider 的装配方式
- RAG、存档、trace 的存储模型
- v2 的 capability / workflow 开放范围

设计原则：

- 像 agent skill 一样低门槛
- 但比 agent skill 更正式、更可扩展
- `SKILL.md` 不是全部，`manifest.json` 才是机器契约

## 2. Package 基本形态

每个 package 至少包含：

```text
my-package/
├─ manifest.json
├─ SKILL.md
├─ schemas/
├─ prompts/
├─ server/
├─ client/
└─ assets/
```

说明：

- `manifest.json`
  - 机器可读契约
- `SKILL.md`
  - 面向 LLM / agent 的行为规范
- `schemas/`
  - command / block / settings / response schema
- `prompts/`
  - package prompt layer 或文案模板
- `server/`
  - 可选 TS 运行逻辑
- `client/`
  - 可选 renderer

## 3. 三层 package 能力模型

### 3.1 Skill-only

最轻 package：

- `manifest.json`
- `SKILL.md`
- 基础 schema

适用场景：

- 轻量上下文补充
- 简单命令
- 简单交互块

### 3.2 Declarative

在 skill-only 基础上增加：

- prompt layer 配置
- command schema
- block schema
- settings schema

适用场景：

- 可配置的内容包
- 规则明确但逻辑较轻的功能包

### 3.3 Programmable

在 declarative 基础上增加：

- `server/index.ts`
- `client/renderers.tsx`

适用场景：

- 复杂命令处理
- 自定义交互
- 复杂 UI 呈现

## 4. Manifest 责任

`manifest.json` 至少声明：

- `name`
- `version`
- `description`
- `scopes`
- `permissions`
- `contributes.commands`
- `contributes.context`
- `contributes.blocks`
- `contributes.renderers`
- `modelPolicy`

v1 不做多版本协议分叉。

manifest 只保留一个正式版本号：

- `schemaVersion`

### 4.1 Manifest 最小形状

为了让 loader、registry 和 package authoring 无歧义，v1 的最小 manifest 形状固定为：

```json
{
  "schemaVersion": "1.0",
  "name": "core-guide",
  "version": "0.1.0",
  "description": "Guide and interactive choice package",
  "scopes": ["world", "session"],
  "permissions": ["read:world", "read:session", "emit:block"],
  "modelPolicy": {
    "preferredTier": "small"
  },
  "contributes": {
    "context": [],
    "commands": [],
    "blocks": [],
    "renderers": []
  }
}
```

`contributes` 四类最小 entry 形状固定如下：

#### Context Provider

```json
{
  "id": "guide-context",
  "entry": "server/context.ts",
  "reads": ["world", "session", "memory"],
  "writes": []
}
```

#### Command

```json
{
  "name": "guide",
  "description": "Generate a guide block",
  "argsSchema": "schemas/commands/guide.args.json",
  "entry": "server/commands/guide.ts",
  "resume": false
}
```

#### Block

```json
{
  "type": "choices",
  "dataSchema": "schemas/blocks/choices.data.json",
  "responseSchema": "schemas/blocks/choices.response.json",
  "ui": {
    "component": "schema",
    "renderer": "choices"
  }
}
```

#### Renderer

```json
{
  "name": "story-image",
  "entry": "client/renderers/story-image.tsx"
}
```

## 5. SKILL.md 责任

`SKILL.md` 负责告诉系统与模型：

- 这个 package 解决什么问题
- 什么时候应启用
- 什么时候不要启用
- 读取哪些上下文
- 如何输出 block
- 何时请求用户进一步输入
- 何时结束，不做过度猜测

`SKILL.md` 只定义行为，不承担机器校验职责。

## 6. Progressive Disclosure

为避免启动时读入过多上下文，package 加载采用渐进式读取：

1. 发现阶段只读 manifest
2. package 启用时读取 `SKILL.md`
3. 真正执行时按需读取 schemas / prompts / assets

不允许在系统启动时一次性加载所有 package 的全部文档内容。

## 7. V1 允许的贡献范围

v1 package 允许贡献：

- `context provider`
- `prompt layer`
- `slash command`
- `block schema`
- `schema UI`
- `optional custom renderer`

典型第一方 package：

- `core-worldbook`
- `core-character-card`
- `core-persona`
- `core-memory-rag`
- `core-archive`
- `core-guide`
- `core-presets`
- `core-debug-commands`

## 8. V1 禁止的贡献范围

v1 package 禁止贡献：

- workflow nodes
- arbitrary capability runtime
- Python / 其他语言 hook runtime
- 任意前端脚本注入
- 任意后端路由劫持

理由：

- v1 要先把上下文、命令、交互块这条主链路做稳
- 不能在 package 模型还没稳定时开放全平台级扩展点

## 9. 命令系统

### 9.1 总原则

slash command 是核心系统，不是 UI 小功能。

所有命令统一经过：

- `SlashParser`
- `CommandRegistry`
- `CommandBus`

### 9.2 命令语法

基本语法固定为：

```text
/command
/command arg1 arg2
/command --flag value
```

v1 需要支持：

- 帮助文本
- 参数 schema
- 错误提示
- 自动补全元数据

`SlashCommandSpec` 最小形状固定为：

```json
{
  "name": "memory",
  "description": "Search memory",
  "argsSchema": "schemas/commands/memory.args.json",
  "handler": "server/commands/memory.ts",
  "resume": false
}
```

### 9.3 核心命令

建议 v1 至少提供：

- `/help`
- `/packages`
- `/trace`
- `/memory`
- `/archive`
- `/session`

### 9.4 Package 命令

package 可通过 manifest 注册命令：

- 命令名
- 参数 schema
- 帮助文本
- handler 入口
- 是否可恢复执行

package 命令可以：

- 直接返回结构化结果
- 触发新的子 flow
- 输出 interactive block

## 10. Block 与交互协议

### 10.1 标准 Block Envelope

每个 block 至少包含：

- `id`
- `type`
- `version`
- `data`
- `meta`
- `interaction`

最小 JSON 形状固定为：

```json
{
  "id": "blk_01",
  "type": "choices",
  "version": "1.0",
  "meta": {
    "package": "core-guide",
    "requestId": "req_01",
    "traceId": "tr_01",
    "sessionId": "ses_01",
    "turnId": "turn_01"
  },
  "interaction": {
    "requiresResponse": true,
    "responseSchema": "schemas/blocks/choices.response.json",
    "submitAs": "block_response",
    "resumePolicy": "resume_current_flow"
  },
  "data": {
    "title": "下一步做什么？",
    "options": [
      { "id": "opt_a", "label": "继续前进" },
      { "id": "opt_b", "label": "调查周围" }
    ]
  }
}
```

### 10.2 交互字段

`interaction` 至少支持：

- `requiresResponse`
- `responseSchema`
- `submitAs`
- `resumePolicy`

### 10.3 标准交互块类型

v1 固定支持：

- `choices`
- `form`
- `confirm`
- `request_input`

这些类型足以覆盖：

- 选项选择
- 表单填写
- 确认步骤
- 插件向用户追问

### 10.4 BlockResponse

用户响应统一通过 `BlockResponse` 返回，至少包含：

- `blockId`
- `blockType`
- `response`
- `sessionId`
- `turnId`

不得把关键响应只作为普通聊天文本混进消息流。

最小 JSON 形状固定为：

```json
{
  "blockId": "blk_01",
  "blockType": "choices",
  "sessionId": "ses_01",
  "turnId": "turn_01",
  "response": {
    "selected": "opt_a"
  }
}
```

规则：

- `response` 必须满足对应 block 的 `responseSchema`
- `blockId + turnId + sessionId` 必须能定位回原始 flow
- 未通过 schema 校验的响应不得进入 resume 流程

## 11. Resume 规则

当 runtime 收到 `BlockResponse` 时，必须：

1. 校验 `responseSchema`
2. 找到原始 block 与原始 flow
3. 恢复上下文
4. 继续后续执行

v1 恢复执行只支持：

- 当前会话内恢复
- 单一 flow 链路恢复

不支持复杂跨 flow 编排。

## 12. 前端扩展规则

v1 前端扩展采用：

- `Schema UI + 可选 custom renderer`

规则：

- 默认走 generic renderer
- 少量 package 可注册 React renderer
- renderer 必须遵守 host runtime 的 props 与事件边界
- package 不得直接修改 host 页面结构

UI 设计规范固定为：

- Web host 默认使用 `shadcn/ui`
- schema UI 的默认映射必须优先落到 `shadcn/ui` 组件
- package 自定义 renderer 必须遵守同一套 spacing、form、dialog、panel 约定
- 不允许 package 自带另一套完整设计系统覆盖宿主风格

### 12.1 Schema UI 与 shadcn/ui 的默认映射

为避免实现者自行发明 UI 组件映射，v1 默认规则固定如下：

- `choices`
  - `Card` + `Button`
- `form`
  - `Form` + `Input` / `Textarea` / `Select` / `Checkbox`
- `confirm`
  - `AlertDialog` 或 `Dialog`
- `request_input`
  - `Dialog` + `Form`
- 调试页
  - `Table` / `Tabs` / `Sheet` / `Accordion` / `Badge`

### 12.2 Package Renderer 设计规范

package 自定义 renderer 在视觉和交互上必须遵守宿主规范，默认采用 `$frontend-skill` 中提炼出的这些规则：

- 每个区域只承担一个主要职责
- 先用布局、留白、比例和对齐建立层级，不优先堆组件
- 默认采用克制的产品界面风格，而不是营销页式堆砌
- 文案优先 utility copy，标题先说明“这里是什么 / 能做什么”
- 尽量避免重复说明、情绪化空话和 filler copy
- 默认不做卡片拼贴式布局
- card 仅在其本身是交互对象时使用
- 自定义 renderer 不得引入第二套视觉语言覆盖宿主

对于 visually-led 的内容块，例如图片、世界展示、叙事关键节点，允许适度提升视觉表现力，但仍要遵守：

- 一个区块一个主视觉意图
- 一个区块一个主要操作
- 文本必须可快速扫描
- 动效必须有明确层级或氛围价值
- 不得使用会干扰可读性的 busy imagery

### 12.3 文案与动效约束

package renderer 的文案规则：

- 标题优先表达信息，而不是气氛口号
- 支撑文案通常只保留 1 句
- 如果删除 30% 文案后更清楚，就继续删

package renderer 的动效规则：

- 只允许少量、有意图的动效
- hover / reveal / transition 必须提升可用性或层级感
- 不允许为“显得高级”而堆叠装饰性动画

## 13. 最小实现原则

为了遵循奥卡姆剃刀原则，v1 包系统不做：

- 动态安装远程包
- 远程代码执行
- 包级多语言运行时
- 包级自定义数据库迁移
- UI 任意挂载

先把：

- 上下文
- 命令
- 交互块
- schema UI

这四件事做稳。
