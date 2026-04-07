# 插件系统 V1 设计

时间：2026-04-07  
状态：草案  
类型：系统设计主文档

## 系统定位

Covel 本质上是一个 **Agent 编排框架**。

- **Framework**：只负责调度 runtime、注入上下文、管理工具调用、记录执行历史、处理审批和热重载
- **Plugin**：安装、配置、启停、依赖声明单位
- **Runtime**：真正的执行单位。每个 runtime 都是一个完整 agent

框架定型后，所有业务能力都通过插件提供。插件**不能修改框架代码**，只能使用框架公开的扩展点。

## V1 核心决策

### 1. Runtime First

- 插件可以包含一个或多个 runtime
- 多 runtime 插件按 `runtimes/<runtime-id>/` 组织
- 如果插件没有显式拆成多个 runtime，则把它视为一个默认 runtime
- 每个 runtime 必须有独立的：
  - `runtime.json`
  - `llm.toml`
  - `instructions.md`
  - `output.schema.json`
  - `runtime-level settings`

插件根目录的 `PLUGIN.md` 是**公共 prompt**，会自动注入到该插件的所有 runtime 前面。

### 2. Plugin 不是宿主代码注入点

V1 不把 `server/` / `client/` 作为插件核心模型。插件的核心能力来自：

- `plugin.json`：插件壳与聚合信息
- `PLUGIN.md`：插件公共 prompt
- `runtimes/<runtime-id>/runtime.json`：runtime 声明
- `runtimes/<runtime-id>/tools/`：对 agent 暴露的正式 tools
- `runtimes/<runtime-id>/scripts/`：插件私有脚本资产
- `runtimes/<runtime-id>/references/`：按需加载的参考材料
- `runtimes/<runtime-id>/tests/`：runtime 测试

### 3. 前端入口也是声明式合同

插件还可以声明统一前端入口，而不是自己注入前端代码：

- `actions`：按钮、快捷动作、手动 workflow 入口
- `blockSchemas`：结果展示 block 的 schema

前端负责按合同渲染，插件只声明：

- 注入到哪里
- 如何显示
- 点击后启动什么 workflow
- 异步阶段状态如何展示

## 编排模型

### 优先级区间

所有 runtime 按优先级从小到大执行，区间固定为 `0-1000`。

```text
0-99     pre-game / turn0
100      开始游戏边界
101-1000 正式 turn 循环
```

关键规则：

- `0` 优先级最高，`1000` 最低
- `<100` 是 `pre-game` 阶段，只在开局前执行
- `100` 是点击“开始游戏”的硬边界
- `100-1000` 是正式主循环：`turn1 -> turn2 -> turn3 -> ...`
- 同优先级 runtime 并行执行
- 较低优先级 runtime 可以读取较高优先级**已经提交**的结果
- 同优先级并行 runtime 不能读取彼此本轮正在产生的结果

### 触发模型

V1 最小触发集合：

- `pre-game-once`
- `turn`
- `event`
- `manual`
- `approval-callback`

补充规则：

- `pre-game-once` runtime 即使声明了多次触发，也只会在 `turn0` 跑一次
- `100-1000` 内 runtime 默认可无限次触发
- runtime 可以声明：
  - `maxRunsPerSession`
  - `maxRunsPerTurn`
- 这些限制都按 `session` 单独计数
- 同一 turn 内多次运行，必须由新的触发再次唤起，调度器不会主动连跑直到耗尽次数

## 数据模型

框架维护三层数据面。

### 1. Full Trace

框架内部完整保留所有执行细节：

- LLM 输入输出
- tool call
- `exec_script`
- 结构化输出校验
- 审批决策
- 写入前后差异
- 错误与超时

这层主要用于调试、审计和回放，不直接作为插件间共享接口。

### 2. Published Records

每次 runtime 执行都会产出一条标准化记录，由框架统一包装外层 envelope。

- `success` 也有记录
- `failed` 也有记录
- `approval_denied` 也有记录
- `skipped_condition` 也有记录
- `skipped_limit` 也有记录

runtime 自己只负责产出符合 `output.schema.json` 的结构化 payload。框架补齐：

- `pluginId`
- `runtimeId`
- `sessionId`
- `turnId`
- `runId`
- `status`
- `timestamp`
- `traceId`
- `locale`

插件之间默认读取的是这层。

### 3. Live State Tables

框架维护当前快照型状态表，供游戏进行中读写。

关键规则：

- 表有 owner
- 默认插件只能写自己拥有的表
- 共享表同样有 owner
- 其他插件若想修改共享表，必须调用 owner 暴露的 tool
- schema 可以在运行期变更
- schema 变更只允许**兼容性修改**
- 每次 schema 变更都必须保留完整历史记录

查询层面：

- 默认读取最新快照
- 也要支持历史版本回看
- 也要支持字段 diff

## Tools 与 Scripts

### tools/

`tools/` 是对 agent 暴露的正式能力合同。

- 每个 tool 独立文件
- 必须声明：
  - `id`
  - `description`
  - `input schema`
  - `output schema`
  - 是否对外导出
- 框架会把这些 tool 解析成 function-calling 规格并注入 runtime

### scripts/

`scripts/` 是插件私有脚本层，通过统一的 `kernel:exec_script` 调用。

- 不直接作为插件生态的主要共享接口
- 允许实现复杂逻辑
- 返回值必须可被规范化为 JSON 或 string
- 即使返回 string，也必须最终落到符合 output schema 的 JSON 结果中

### 跨插件 tool 共享

共享 tool 必须双向显式声明：

- 提供方声明该 tool 对外导出
- 使用方在 runtime 声明自己要导入哪些外部 tool

框架通过统一的 registry / invocation gateway 做中转：

- schema 校验
- 参数解析
- 权限检查
- 审批
- 审计记录
- 热重载后的重新绑定

插件不能直接加载其他插件的代码或工具文件。

## 插件动作与统一 UI

除了 runtime 本身，插件还可以声明：

- `actions`
- `blockSchemas`

设计原则：

- 插件不为了一个按钮单独写前端代码
- 前端统一渲染 action/button
- action 可以启动异步多 runtime workflow
- workflow 进度状态也由插件声明文案、前端统一渲染

## 审批模型

框架统一拦截：

- tool 调用
- `exec_script`
- 其他受控敏感操作

规则：

- 特殊白名单中的内置插件 runtime 默认放行
- 非白名单插件默认需要授权
- 授权粒度是 `session + plugin + tool`
- 一次授权后在该 session 内持续有效
- 插件热重载或升级后，已存在的授权继续有效

## i18n 与输出

- 前端当前 locale 会被显式注入 runtime prompt
- runtime 输出必须使用当前 locale 的自然语言
- 但对外记录仍然必须是结构化 JSON
- 任何可能被其他插件消费的输出，都不能只是一段自由文本

## 核心插件类型

### `pluginType = "core-plugin"`

- 默认开启
- 玩家不能主动关闭
- 与普通插件在读写能力、数据可见性、tool 机制上没有特权差异

### `pluginType = "plugin"`

- 可启用/禁用
- 提供可选玩法或扩展能力

## 阅读顺序

1. [plugin-spec.md](./plugin-spec.md)：插件包与 runtime 包的正式规格
2. [builtin-tools.md](./builtin-tools.md)：V1 内置工具最小集
3. [plugin-examples.md](./plugin-examples.md)：核心插件与扩展示例
4. [phase-1-event-bus.md](./phase-1-event-bus.md)：触发事件、业务事件、运行时总线事件
5. [phase-2-services.md](./phase-2-services.md)：统一数据与调用网关
6. [phase-3-runtime-context.md](./phase-3-runtime-context.md)：runtime 上下文与 structured output
7. [phase-4-plugin-manager.md](./phase-4-plugin-manager.md)：插件加载、注册表与热重载
8. [phase-5-kernel-pipeline.md](./phase-5-kernel-pipeline.md)：turn 调度与 runtime 提交模型
9. [phase-6-runtime-api.md](./phase-6-runtime-api.md)：runtime 独立执行 API
