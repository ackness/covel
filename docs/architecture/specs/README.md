# V1 执行规范入口

## 1. 这组文档是干什么的

如果你准备直接实现 covel v1，请先读本目录。

这组文档承担：

- v1 的正式工程规范
- 直接影响目录、接口、协议、存储、RAG、UI、package 的决策

这组文档不承担：

- 长期愿景论证
- 平台商业化设计全集
- v2 / v3 远期能力开放范围

长期原则与系统愿景仍然在：

- `docs/plans/next/*`

如果原则文档和本目录看起来有差异：

- `docs/plans/next/*` 代表长期能力全集
- `docs/architecture/specs/*` 代表 v1 正式开放范围
- 实现时一律以本目录为直接依据

## 2. 先读什么

推荐顺序：

1. `00-v1-open-core-plan.md`
2. `01-runtime-repo-provider-spec.md`
3. `02-package-command-ui-spec.md`
4. `03-memory-rag-archive-observability-spec.md`

如果你只剩 10 分钟，至少先读：

1. `00-v1-open-core-plan.md`
2. 本文件

## 3. 一页决策摘要

v1 已固定的高优先级决策：

- 产品边界：单机自部署、Web 优先、不实现 Hosted Platform
- 技术路线：TypeScript Monorepo、React、Node、PostgreSQL、Local Artifact Store
- 前端基线：`Vite 8`、`shadcn/ui`
- 主协议：`HTTP action + SSE streamed response`
- 模型层：`ModelGateway + ProviderRegistry + ModelProfileRegistry`
- profile：`small / medium / large + embed-default`
- package 形态：`manifest.json + SKILL.md + optional TS code`
- package v1 只开放：
  - context provider
  - prompt layer
  - slash command
  - block schema
  - schema UI
  - optional custom renderer
- package v1 不开放：
  - workflow nodes
  - arbitrary capability runtime
  - Python / 其他语言 hook runtime
- 记忆与检索：M1 直接做完整 RAG，但只用 `PostgreSQL + pgvector + FTS + entity_edges`
- 调试与追踪：本地 trace/debug UI 是正式能力，未来通过 OpenTelemetry 接 Langfuse

## 3.1 统一术语

为避免不同文档使用不同词导致误读，v1 统一采用下面的术语：

### 品牌与命名约定

文档中的品牌与系统名统一采用下面写法：

- `covel`
  - 项目与产品名
- `Open Core Runtime`
  - 开源核心运行时层的正式名称
- `Web Host`
  - Web 宿主的正式名称
- `apps/web`
  - Web Host 的仓库目录名
- `apps/runtime`
  - Open Core Runtime 的主装配应用目录名

规则：

- 对外和架构讨论中优先使用 `covel`
- 讨论系统层次时使用 `Open Core Runtime`、`Hosted Platform Layer`、`Web Host`
- 讨论具体代码路径时使用 `apps/web`、`apps/runtime`

### `Package`

v1 的标准安装与运行单位。

含义固定为：

- 一个可被 runtime 发现、加载、启用、禁用的扩展包
- 目录结构以 `manifest.json + SKILL.md + optional TS code` 为基线

实现时，凡是涉及：

- package runtime
- package loader
- package registry
- package enable / disable

都统一使用 `Package` 一词。

### `Extension`

长期架构语义中的泛化扩展概念。

在 `docs/plans/next/*` 中，`extension` 常用于描述更宽泛的扩展平台能力。
到了 v1 执行层，一律收敛到 `Package` 这一正式术语。

简单说：

- 长期讨论里可以说 `Extension`
- v1 实现里请写 `Package`

### `Skill`

不是安装单位，也不是 runtime 对象。

v1 中固定表示：

- package 内部的 LLM/agent 行为说明层
- 对应文件就是 `SKILL.md`

简单说：

- `Skill` 是 package 的作者体验层
- `Package` 才是系统装载单位

### `Block`

统一的内容与交互单元。

用于：

- 展示内容
- 交互输入
- UI 恢复点

block 不是 artifact，也不是 message 的别名。

### `Artifact`

统一的生成产物对象。

用于：

- 图片
- 音频
- 导出文档
- 可交付结果文件

artifact 不是 block，也不是附件别名。

### `Flow`

统一的执行链语义。

v1 中正式包括：

- `turn flow`
- `command flow`
- `resume flow`

长期文档里的 `workflow flow / job flow / automation flow` 属于未来 flow 家族，不代表 v1 全部开放。

## 4. 实现顺序

按下面顺序实现，风险最低：

1. 建立 monorepo 骨架
2. 实现 `contracts + domain + command-system`
3. 实现 `model-gateway + provider registry + profile registry`
4. 实现 `PostgreSQL repository + local artifact store`
5. 实现 `turn flow / command flow / resume flow`
6. 实现 `package runtime`
7. 实现 `memory-rag + archive + observability`
8. 实现 Web host、debug 页面、第一方 packages

## 5. Day-1 交付范围

M1 首批必须可运行的能力：

- world 创建与保存
- session 创建与推进
- `/command` 系统
- interactive block 与 `BlockResponse`
- provider 抽象与 profile 路由
- memory ingestion
- hybrid retrieval
- archive create / restore / fork restore
- trace / retrieval / prompt 调试页
- 第一方 package：
  - `core-worldbook`
  - `core-character-card`
  - `core-persona`
  - `core-memory-rag`
  - `core-archive`
  - `core-guide`
  - `core-presets`
  - `core-debug-commands`

## 6. 非目标

实现 v1 时不要顺手做这些：

- marketplace
- billing
- sync
- tenant / organization
- 复杂 workflow 可视化编排
- 任意 capability runtime 平台化
- 多语言 package hook runtime
- 第二套设计系统

## 7. 交接标准

如果要把任务交给另一位工程师，他至少应该能只靠本目录回答：

- 仓库怎么建
- 主协议是什么
- 包怎么写
- 命令怎么走
- 用户交互如何恢复 flow
- provider 怎么接
- RAG 最小默认值是什么
- trace / archive / memory 怎么落库

如果这些问题还答不出来，就继续收紧规范，而不是先写代码。
