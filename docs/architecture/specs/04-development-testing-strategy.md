# 04. 开发与测试策略

## 1. 目标

本文件定义 covel v1 的开发执行方式。

本文件决定：

- `TDD` 的基本执行规则
- 测试分层
- 真实 LLM 测试边界
- Web Host 的测试重点
- runtime/core 的测试重点
- 并行开发与并行测试原则

本文件不决定：

- 具体业务 schema
- package 的产品语义
- provider adapter 的底层实现细节

## 2. 固定前提

v1 的工程执行固定采用下面前提：

- 相对 `../ai-gamestudio-dev` 完全重构
- 只参考旧项目的能力范围与交互体验
- 不兼容旧代码、旧数据、旧插件
- 默认优先可运行的 M1 闭环，而不是只搭骨架
- 默认采用并行开发
- 可使用多个 subagent 并行推进互不重叠的模块

## 3. TDD 总原则

每个模块都遵循下面顺序：

1. 先写失败测试
2. 再写最小实现
3. 通过测试后再重构

补充规则：

- 优先 deterministic tests
- mocked integration tests 用于验证模块拼装
- live LLM tests 只用于高价值集成验证
- 不允许用 live LLM tests 替代 parser、schema、状态机、存储、权限、安全相关测试

## 4. 测试分层

### 4.1 Deterministic Tests

覆盖：

- `contracts`
- `domain`
- repository invariant
- parser
- schema 校验
- flow 状态机
- archive lineage
- trace / audit / log 写入
- fallback / retry / timeout / cancel
- 权限、安全、脱敏

特点：

- 不依赖真实 LLM
- 结果必须稳定
- 是阻塞 CI 的主力测试

### 4.2 Mocked Integration Tests

覆盖：

- action endpoint 与 SSE 事件流拼装
- `ModelGateway` 与 provider adapter 的边界
- `package runtime` 注册、启用、禁用
- `turn / command / resume flow` 的主链路
- Web Host 中 action dispatcher、SSE consumer、store、workspace panels 的集成
- archive restore 后的 UI 刷新

特点：

- 允许使用 mock provider、mock runtime、mock SSE stream
- 重点验证协议拼装与模块协作

### 4.3 Live LLM Tests

只覆盖：

- `openai-compatible` adapter 冒烟
- 结构化输出在真实模型下是否满足 schema
- `turn flow / command flow / resume flow` 的最小真实主链路
- 第一方 package prompt 的高价值 smoke
- interactive block 与 `BlockResponse` 在真实模型下是否能跑通

不覆盖：

- 精确文案
- 精确 token 数
- 精确事件顺序中的细碎 UI 表现
- 任何可由 deterministic test 覆盖的边界条件

## 5. 真实 LLM 测试策略

### 5.1 Provider 基线

live tests 的 day-1 provider 基线固定为：

- `DashScope`
- 通过 `openai-compatible` 接口接入

### 5.2 模型分工

主 live 测试模型固定为：

- `qwen3.5-flash`

小型且不要求性能的 live tests 可使用：

- `Qwen3.5-35B-A3B`

分工规则：

- `qwen3.5-flash`
  - 主链路
  - 流式响应
  - 较长上下文
  - 接近生产体验的 smoke
- `Qwen3.5-35B-A3B`
  - 小 prompt
  - schema smoke
  - package prompt smoke
  - 低成本兼容性检查

### 5.3 断言原则

live tests 只断言 invariant：

- 可解析
- schema 合法
- 必填字段存在
- 枚举值合法
- block 类型合法
- `BlockResponse` 可被 resume flow 接受
- trace id / request id / flow id 可关联

禁止断言：

- 指定句子
- 指定措辞
- 指定长度
- 指定 token 数

### 5.4 并发、重试与分层

live tests 分成三类：

- `smoke`
- `nightly`
- `probe`

规则：

- PR 默认只跑 `smoke`
- `nightly` 与 `probe` 可在夜跑或手动触发时运行
- CI 中 live tests 的总并发建议起步为 `1-2`
- 本地开发时建议并发为 `2-4`
- 使用 semaphore 控制真实请求并发，不直接放开测试 runner 全并行
- 只对网络错误、超时、`408/429/5xx` 做有限重试
- 鉴权错误、schema 错误、明确业务错误直接失败

### 5.5 环境变量建议

建议统一使用下面环境变量：

```env
LIVE_LLM_ENABLED=1
LIVE_LLM_SUITE=smoke
LIVE_LLM_PROVIDER=dashscope
LIVE_LLM_PRIMARY_BASE_URL=...
LIVE_LLM_PRIMARY_API_KEY=...
LIVE_LLM_PRIMARY_MODEL=qwen3.5-flash
LIVE_LLM_SECONDARY_MODEL=Qwen3.5-35B-A3B
LIVE_LLM_TIMEOUT_MS=30000
LIVE_LLM_MAX_RETRIES=2
LIVE_LLM_MAX_CONCURRENCY=2
LIVE_LLM_TEMPERATURE=0
LIVE_LLM_RECORD_DIR=.artifacts/live-llm
```

如果项目已有更具体的 provider 环境变量，也允许在 test harness 中映射到这些统一名称。

## 6. Runtime/Core 必要测试

M1 至少覆盖下面模块：

- `contracts`
  - `ActionRequest`
  - SSE envelope
  - `Block`
  - `BlockResponse`
  - `TraceRecord`
  - `RetrievalRun`
  - `ArchiveVersion`
- `domain + storage`
  - `World`
  - `Session`
  - `Message`
  - `Artifact`
  - `ModelProfile`
  - `Archive`
  - `MemoryDocument`
- `flow-engine`
  - `send_message`
  - `execute_command`
  - `submit_block_response`
- `model-gateway`
  - openai-compatible adapter
  - stream
  - structured output
  - embedding
  - error normalization
- `package-runtime`
  - manifest discovery
  - progressive loading
  - command registry
  - block registry
  - enable / disable
- `memory-rag`
  - ingestion
  - chunking
  - hybrid retrieval
  - fallback
  - provenance
- `archive`
  - create
  - restore-in-place
  - restore-as-fork
  - lineage
  - reindex mark
- `observability`
  - app log
  - audit log
  - trace record

### 6.1 必须最先写的测试

为了避免回到旧项目那种 `chat / plugin / prompt / archive` 混层状态，下面这些测试必须最先写：

1. `contracts` 的 schema 与 golden tests
2. `domain` 的 invariant 与 repository port contract tests
3. `flow-engine` 的 deterministic state-machine tests
4. `model-gateway` 的 adapter contract suite
5. `package-runtime` 的 loader / security / progressive-disclosure tests
6. `storage` 的 port conformance tests
7. `observability` 的 correlation / redaction tests
8. `memory-rag` 的 chunking / fallback / idempotency tests
9. `archive` 的 lineage / restore tests

`live LLM` 测试必须在上述测试稳定后再接入，不能作为日常 red-green 主循环的前置依赖。

## 7. Web Host 必要测试

M1 Web Host 的关键工作流固定为：

1. 打开 world
2. 自动复用或创建 session
3. 发送 `send_message` 或 `execute_command`
4. 消费 SSE 流
5. 渲染 interactive block
6. 提交 `BlockResponse`
7. 执行 archive restore
8. 跳转或查看 trace / archive 摘要

建议三层测试划分：

- `Component`
  - SSE reducer
  - session bootstrap
  - block 本地状态
  - schema form mapping / validation
  - archive restore modal
- `Integration`
  - action dispatcher + SSE consumer + store
  - pending block attach / update / lock
  - preset fetch / save / scope merge
  - archive restore 后 reload
- `E2E`
  - world -> session bootstrap -> turn flow -> block resume -> archive restore

重点断言：

- `message.delta` 正确拼接
- `message.completed` 正确封口
- `block.emitted / block.updated` 正确 patch
- `flow.failed` 与普通 `error` 区分正确
- `BlockResponse` payload 必含 `blockId / blockType / sessionId / turnId`
- 已提交 block 会锁定
- restore 后 stale pending UI 会被清空

## 8. 第一方 Package 测试要求

每个第一方 package 至少要有：

- manifest 校验测试
- schema 校验测试
- prompt layer 编译测试
- command 或 handler 测试
- block emission 测试

如果 package 提供自定义 renderer，还必须补：

- renderer component test
- renderer integration test

## 9. 并行开发策略

在共享协议冻结后，建议拆成下面几条并行开发线：

1. `contracts + domain + storage`
2. `model-gateway + preset/profile registry`
3. `flow-engine + action/SSE`
4. `package-runtime + first-party packages`
5. `memory-rag + archive + observability`
6. `apps/web` 主界面与 E2E

并行约束：

- 每条线只负责自己的文件与模块边界
- 共享契约先冻结，再展开并行实现
- deterministic tests 可以最大化并行
- live tests 只在共享契约稳定后逐步接入

建议提前准备下面这些测试支撑件：

- `ScenarioBuilder`
  - 固定 clock、UUID、requestId、traceId，快速构造 `world / session / turn / archive`
- `Protocol Goldens`
  - `ActionRequest`、SSE、`Block`、`BlockResponse`、`TraceRecord`、`RetrievalRun`、`ArchiveVersion`
- `FlowHarness`
  - fake repos + fake model gateway + fake package runtime + fake retrieval + SSE recorder
- `ProviderAdapterHarness`
  - fake openai-compatible server，支持 stream chunk、usage、timeout、429、malformed payload
- `PostgresHarness`
  - 临时数据库、迁移、`pgvector`、每测重置 schema
- `ArtifactStoreHarness`
  - tmp fs root、checksum、故障注入、metadata/path 断言
- `PackageFixtureFactory`
  - 快速生成 `skill-only`、`declarative`、`programmable` package
- `RagCorpusFixtures`
  - world/persona/worldbook/archive/recent-turn/package-memory 的固定语料与期望命中
- `DeterministicEmbedder`
  - 非 live RAG 测试的稳定 embedding 替身
- `ObservabilitySink`
  - in-memory app log / audit log / trace collector + OTEL exporter stub
- `LiveLlmHarness`
  - 按环境变量选择 provider / model，缺凭据自动 skip，只做 invariant assertions

## 10. 推荐工具组合

v1 推荐测试工具组合：

- `vitest`
- `playwright`
- `React Testing Library`
- `user-event`
- `MSW`
- `zod`

SSE 测试建议：

- 不伪装成 `WebSocket`
- 直接使用 `ReadableStream` 或本地 stream fixture

## 11. 交付门槛

一个模块只有在满足下面条件后，才算完成：

- deterministic tests 通过
- 必要的 mocked integration tests 通过
- 若属于主链路模块，则对应 live smoke 通过
- 文档、fixture、test harness 已补齐

如果一个行为只能通过人工点击验证，还没有自动化测试，它就还不算真正完成。
