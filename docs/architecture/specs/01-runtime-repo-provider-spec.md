# 01. Runtime、仓库与 Provider 规范

## 1. 目标

本规范定义 v1 的物理仓库结构、运行时边界、主通信协议和统一模型 provider 抽象。

本文件决定：

- monorepo 物理结构
- apps / modules / extensions 的职责边界
- turn / command / resume 三条主 flow 时序
- `ModelGateway`、`ProviderRegistry`、`ModelProfileRegistry`
- day-1 provider 范围
- 主数据库与 artifact store 边界
- 主传输协议与 SSE wire shape

本文件不决定：

- package 的高层 authoring 规则
- command 的产品语义
- RAG 的检索算法细节

本规范不定义 package 写法、命令语法、RAG 细节。那些内容分别由后续规范负责。

## 2. Monorepo 结构

建议目录固定为：

```text
/
├─ apps/
│  ├─ web/
│  └─ runtime/
├─ modules/
│  ├─ contracts/
│  ├─ domain/
│  ├─ command-system/
│  ├─ context-graph/
│  ├─ prompt-graph/
│  ├─ flow-engine/
│  ├─ model-gateway/
│  ├─ package-runtime/
│  ├─ storage/
│  ├─ memory-rag/
│  ├─ archive/
│  ├─ observability/
│  ├─ artifact-store/
│  └─ sdk-package/
├─ extensions/
└─ docs/
```

约束：

- `apps/*` 只做装配，不承载底层通用逻辑
- `modules/*` 只暴露稳定接口，不允许反向依赖 `apps/*`
- `extensions/*` 只能依赖 `sdk-package` 与 `contracts`
- 仓库内部库目录使用 `modules`，避免与系统中的 `Package` 概念混淆

## 2.1 前端与依赖版本策略

v1 前端工具链基线固定为：

- `Vite 8`

包管理与版本策略固定为：

- 使用 workspace 级锁文件统一锁定依赖
- 所有一方依赖默认选用实现时的最新稳定版
- `package.json` 使用精确版本号，不使用 `^`、`~` 这类宽松范围
- AI 相关核心依赖、构建工具、测试工具应优先跟进最新稳定版
- 新依赖引入前优先检查是否已有成熟能力可复用，避免为单点问题堆叠库

实现阶段必须优先评估这些依赖是否满足需求：

- `vite`
- `react`
- `typescript`
- `drizzle-orm`
- `pg`
- `pgvector`
- `ai` 与对应 provider 包
- `pino`
- `@opentelemetry/*`

v1 推荐工具链固定为：

- `pnpm`
- `turbo`
- `tsx`
- `vitest`
- `playwright`
- `drizzle-kit`
- `zod`
- `changesets`

## 3. Apps 与 Modules 的职责边界

### 3.1 `apps/web`

负责：

- React UI
- 路由与页面编排
- streamed response 消费
- block 渲染
- trace / retrieval / package 调试页

M1 主界面推荐固定为三栏工作台：

- 左栏
  - `World`
  - `Packages`
  - `Presets`
- 中栏
  - `Session Timeline`
  - composer
  - pending interactive block
- 右栏
  - inspector
  - `State`
  - `Archive`
  - trace 摘要

补充规则：

- 主界面优先承载世界编辑与会话推进
- 复杂调试详情可独立到 debug 页面
- M1 不沿用旧项目的 `WebSocket` 主协议与 store 切法
- 前端主写入入口统一对接 `HTTP action + SSE`

UI 基线固定为：

- `shadcn/ui`

规则：

- 页面、表单、弹窗、侧栏、调试面板默认使用 `shadcn/ui` 组件体系与设计 token
- 不在 host runtime 中混用多套视觉系统
- 自定义组件只能建立在 `shadcn/ui` / Radix primitives / 统一 design token 之上

视觉与交互规范固定为：

- 先做布局与层级，再做组件堆叠
- 默认采用克制、偏产品化的界面风格
- 优先使用 whitespace、对齐、比例、分栏、层级，而不是额外装饰
- 默认少色彩、少边框、少阴影、少装饰性渐变
- 页面必须先明确：
  - primary workspace
  - navigation
  - secondary context / inspector
- 调试页、运维页、工作台类页面默认使用 utility copy，而不是营销文案

默认禁忌：

- dashboard-card mosaic
- 每个区域都加厚边框
- 常规产品界面里堆叠装饰性渐变
- 同一页面多个竞争性的强调色
- 没有叙事意义的轮播、动画或装饰图标

卡片使用规则：

- 默认 cardless layout
- 只有“卡片本身就是交互单元”时才使用 card
- 如果去掉 card 视觉外框后信息仍然清楚，应移除 card treatment

动效规则：

- 动效只用于层级、进入感、可用性或状态反馈
- 必须克制、快速、可在移动端流畅运行
- 没有明显价值的动效一律移除

不负责：

- 直接访问数据库
- 直接拼接 prompt
- 直接管理 provider SDK

### 3.2 `apps/runtime`

负责：

- HTTP API
- turn flow 执行
- command flow 执行
- resume flow 执行
- package 装载
- retrieval / archive / trace / artifact 协调

### 3.3 `modules/contracts`

负责：

- 共享 schema
- 共享 DTO
- 事件协议
- block 协议
- 命令协议
- trace / retrieval / archive 协议

### 3.4 `modules/domain`

负责：

- 领域对象定义
- 领域级 invariant
- repository 接口

### 3.5 `modules/flow-engine`

负责：

- `turn flow`
- `command flow`
- `resume flow`
- 通用 flow 状态机

v1 不开放任意 workflow 节点，但内部执行仍统一在 flow engine 中。

## 4. 标准时序

### 4.1 Turn Flow

标准时序固定为：

1. 接收用户输入
2. 解析命令或普通消息
3. 读取 session/world 状态
4. 构建 `ContextGraph`
5. 运行 `RetrievalPipeline`
6. 构建 `PromptGraph`
7. 选择 `ModelProfile`
8. 调用 `ModelGateway`
9. 输出 `message / block / artifact / state patch / trace`
10. 持久化结果

### 4.2 Command Flow

标准时序固定为：

1. slash parser 识别 `/command`
2. 校验命令参数 schema
3. 路由到 `CommandRegistry`
4. 命令直接返回结果，或启动子 flow
5. 输出 `CommandResult` 与 trace

### 4.3 Resume Flow

标准时序固定为：

1. interactive block 输出 `requiresResponse`
2. 客户端提交 `BlockResponse`
3. runtime 校验 `responseSchema`
4. 使用原始 flow id / turn id 恢复上下文
5. 继续执行后续节点

## 5. ModelGateway 规范

### 5.1 职责

`ModelGateway` 是业务层唯一允许调用的模型入口。

它负责：

- 文本生成
- 结构化对象生成
- 流式生成
- tool calling
- embeddings
- provider 统一错误格式
- metrics / trace 埋点

业务层不得直接调用某家模型 SDK。

### 5.2 ProviderRegistry

`ProviderRegistry` 负责：

- 注册 provider adapter
- 管理 provider 配置
- 管理 endpoint、headers、认证方式
- 将逻辑请求映射到具体 provider

### 5.3 ModelProfileRegistry

v1 固定提供 3 档 profile：

- `small`
- `medium`
- `large`

另外固定一个内部 embedding profile：

- `embed-default`

每个 `ModelProfile` 至少声明：

- `id`
- `tier`
- `provider`
- `model`
- `contextWindow`
- `latencyClass`
- `costClass`
- `supportedModes`

默认策略：

- `large`
  - 世界构建
  - 复杂 retrieval rewrite / rerank
  - 复杂 package 处理
- `medium`
  - 常规会话推进
  - 一般命令处理
- `small`
  - 轻量分类
  - 简单 package 逻辑
  - 低成本辅助步骤

### 5.3.1 Profile 与 Preset 的运行时语义

v1 中面向用户暴露的模型与 provider 选择，统一通过 preset 体验交付。

约束：

- Web Host 中允许编辑的是 preset metadata 与 profile 绑定关系
- preset / profile 元数据必须可落库、可编辑
- 项目和会话层只引用 preset / profile，不直接保存原始 provider 密钥
- 第一方 `core-presets` package 负责提供默认 preset 作者体验

建议最小字段：

- `id`
- `name`
- `provider`
- `model`
- `tier`
- `baseUrl`
- `supportedModes`
- `enabled`
- `isDefault`
- `scope`

运行时解析顺序固定为：

1. runtime 内置默认值
2. 数据库中的 preset / profile 记录
3. project override
4. session override

### 5.4 底层技术建议

v1 优先使用：

- `Vercel AI SDK`

原因：

- 提供多 provider 抽象
- 与 TypeScript/Node/streaming 组合较自然
- 后续接 tracing 比较顺手

补充原则：

- provider 相关依赖默认跟随最新稳定版
- 若某个 provider 官方包更新频繁，优先通过 `ModelGateway` 做隔离，而不是把变动扩散到业务层
- telemetry 与 tracing 也优先沿用 AI SDK 与 OpenTelemetry 兼容生态，避免自造 tracing 协议

核心原则不是绑定某个 SDK，而是保证上层只看见 `ModelGateway` 接口。

### 5.5 Day-1 provider 支持范围

为了保证 v1 可实现且可维护，day-1 provider 支持面固定为：

- `openai-compatible`

补充规则：

- `DashScope`、`OpenRouter`、本地 OpenAI-compatible 服务、其他兼容 OpenAI chat/completions 或 Responses 风格接口的服务，都先归入 `openai-compatible` adapter
- v1 不为每个新平台单独写 adapter，除非它不兼容 `openai-compatible` 语义
- 真实集成测试基线允许优先使用 `DashScope`

### 5.6 凭据与配置来源

v1 自部署模式下，provider 配置来源固定为：

1. 运行时环境变量
2. 本地 runtime 配置文件
3. 数据库中的可编辑 preset / profile metadata

项目和会话只允许保存：

- `modelProfileId`
- `presetId`
- provider 选择结果
- 运行时覆盖引用

项目和会话中不得直接存储原始 API key。

v1 中，`BYOK` 的含义固定为：

- 由自部署操作者提供 provider 凭据
- 系统在运行时注入给 `ProviderRegistry`

v1 不做：

- 多用户密钥保险箱
- 平台级 secret vault
- 最终用户在 Web UI 中持久化保存原始 provider 密钥

补充规则：

- 原始 provider 密钥仍只来自运行时环境变量或本地配置文件
- 数据库只保存 preset metadata、endpoint、model、scope 与 secret reference
- Web Host 可以编辑 preset 的非敏感字段，但不能读取原始 provider 密钥明文

### 5.7 Embedding 配置

规则：

- retrieval 与 ingestion 默认只使用 `embed-default`
- package 不直接选择 embedding provider
- embedding provider 的切换只能通过 runtime 配置完成

## 6. PostgreSQL 与存储边界

v1 主数据库为 `PostgreSQL`。

原因：

- 后续可以平滑迁移到 Supabase / Neon 等在线数据库
- 同时承载事务数据、全文检索、向量检索和轻量关系边
- 避免 v1 先走 SQLite，再在 v1.x 重构数据库边界

### 6.1 Repository / Storage Port

必须预先定义：

- repository interfaces
- storage port
- artifact store port

实现上可以先只落 PostgreSQL + local file system，但业务层不应依赖具体实现。

### 6.2 建议的数据域

- `core`
  - worlds
  - sessions
  - messages
  - blocks
  - artifacts
  - packages
- `memory`
  - memory documents
  - chunks
  - embeddings
  - archive versions
  - retrieval runs
- `ops`
  - audit logs
  - trace records
  - job runs

## 7. Artifact Store

v1 只正式支持：

- local file system artifact store

规则：

- 数据库存 artifact metadata
- 文件系统存 artifact 实体
- 后续接 S3 / R2 时只新增 adapter，不改领域模型

## 8. 主协议

v1 主协议固定为：

- `HTTP action + SSE streamed response`

原因：

- 更适合 Web-first 单机部署
- 对代理、日志、trace、命令回放更直接
- 可以后续再补 WebSocket，不影响领域协议

标准 streamed 事件至少包括：

- `message.delta`
- `message.completed`
- `flow.phase.changed`
- `block.emitted`
- `block.updated`
- `artifact.ready`
- `trace.recorded`
- `error`

### 8.1 Action Request 形状

v1 的主写入入口统一为 action endpoint。

建议形状：

```json
{
  "requestId": "req_01",
  "type": "send_message",
  "sessionId": "ses_01",
  "payload": {
    "content": "继续前进"
  }
}
```

`type` v1 至少支持：

- `send_message`
- `execute_command`
- `submit_block_response`

### 8.2 SSE 事件形状

SSE 响应必须使用：

- `Content-Type: text/event-stream`

每条事件使用：

- `id: <seq>`
- `event: <type>`
- `data: <json>`

`data` 的最小 JSON envelope 固定为：

```json
{
  "type": "message.delta",
  "requestId": "req_01",
  "traceId": "tr_01",
  "sessionId": "ses_01",
  "turnId": "turn_01",
  "flowId": "flow_01",
  "seq": 12,
  "timestamp": "2026-03-24T12:00:00Z",
  "payload": {}
}
```

### 8.3 终止与错误规则

v1 的 SSE 流必须以以下事件之一终止：

- `flow.completed`
- `flow.failed`

错误规则：

- 可恢复局部错误使用 `error` 事件输出，但流可以继续
- 不可恢复错误使用 `flow.failed` 收尾
- 服务端必须保证每条 action 请求最终只有一个终止事件

### 8.4 Keepalive 与重连

v1 SSE 连接使用注释行 keepalive：

```text
:keepalive
```

建议间隔：

- 15 秒

v1 不依赖浏览器自动重放中断的写请求。

如果写请求中断，客户端必须按 `requestId` 判断是否需要显式重试。

## 9. ID 关联规则

v1 统一定义这些关联 id：

- `requestId`
- `traceId`
- `sessionId`
- `turnId`
- `flowId`
- `retrievalRunId`
- `artifactId`

规则：

- 一次外部请求必须有 `requestId`
- 一次完整执行链必须有 `traceId`
- 一次会话推进必须有 `turnId`
- 恢复执行必须复用原 `flowId`
- retrieval 必须记录 `retrievalRunId`

任何日志、审计、trace、model call、archive write 都必须能至少关联到 `traceId + sessionId`。

## 10. 设计限制

为了避免过度设计，v1 明确限制如下：

- 不拆微服务
- 不引入消息队列作为前置依赖
- 不做多数据库主路径
- 不做 provider 直连散落调用
- 不开放任意 workflow graph 配置能力

先让 runtime、provider、repository、streamed protocol 形成最小闭环。
