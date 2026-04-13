# aimock 官方能力概览

基于官方 README 和官方文档入口整理。应优先把它理解为 provider 与协议层的 mock 基础设施，而不是通用业务测试工具。

## 1. 核心能力

- 包名：`@copilotkit/aimock`
- 主要入口：`LLMock`
- 支持方式：
  - 程序内启动 `LLMock`
  - CLI 启动 `npx aimock`
  - GitHub Action
  - Docker / Helm
- 官方强调的场景：
  - LLM API mock
  - Record & Replay
  - 流式协议回放
  - Vitest / Jest 插件
  - 多协议 mock（MCP / A2A / AG-UI / Vector / Services）

## 2. 最小接入方式

README 的最小示例是：

```ts
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({ port: 0 });
mock.onMessage("hello", { content: "Hi there!" });
await mock.start();

process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

// run tests

await mock.stop();
```

可以得到两个直接结论：

- 如果代码能通过 `baseUrl` 或 SDK client URL 切换 provider 地址，`aimock` 的接入通常比较直接。
- 如果代码没有清晰的 HTTP 边界，而只是注入某个接口实现，`aimock` 未必是合适的测试层。

## 3. Record & Replay 适合什么

官方定位：

- 代理真实请求到上游 provider
- 把响应保存成 fixture
- 后续重放，不再访问真实 provider

典型 CLI：

```bash
npx aimock -p 4010 -f ./fixtures
npx aimock --record --provider-openai https://api.openai.com
```

更适合以下场景：

- provider 响应很慢、很贵、很不稳定
- 需要测试 streaming / tool call / structured output 的线格式
- 需要把“真实一小次”压缩成“本地重复跑很多次”

通常不建议直接替代：

- 纯业务逻辑单元测试
- 已经有 fake LLM 的调度/状态机/插件触发测试

## 4. 官方公开强调的辅助能力

- Vitest & Jest 插件
- Strict 模式
- GitHub Action
- Streaming physics
- Chaos testing
- Drift detection

在实践中，最常见的用法通常是：

1. `baseUrl` 指向本地 `aimock`
2. 先录 fixture，再在 CI 回放
3. 只保留少量真实 provider smoke test

## 5. 迁移时应主动确认的点

遇到以下需求时，应先查阅最新官方文档，不要依赖模糊记忆直接接入：

- fixture 匹配字段
- request normalization / `requestTransform`
- strict 模式的失败语义
- 每测试序列隔离的 header / API
- provider-specific 流式格式细节

这些细节随版本变化的可能性较高。
