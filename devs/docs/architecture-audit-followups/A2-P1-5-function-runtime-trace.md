# A2-P1-5 · Function-runtime gateway trace coverage

来源：`audits/2026-04-25-docs-code-framework-alignment/RECOMMENDATIONS.md` §P1-5（"为 function runtime gateway 调用补 trace"）

## 问题

`packages/runtime/src/plugin-runtime-gateway.ts` 的 `generateText / generateImage / generateObject` 直接调用底层 `ai-provider.gateway`，没有写入任何 `trace_events`。结果：

- agent runtime 的 LLM 调用在 `/api/traces/:sessionId` 中可见（`llm.calling` / `message.completed` 等）。
- function runtime 通过 `ctx.gateway.generateImage(...)` 的 provider 调用没有任何 trace，UI debug 只能看到 `runtime.completed` 和 `_jobs/<jobId>` 的最终结果，无法定位 provider 端是哪一步失败、用了哪个模型、用了多少 token。

实际影响最大的是 dashscope-image-gen：插件接入 DashScope wan2.x 后，若图像生成报错、超时或返回空结果，开发者无法在 trace 视图里看到 provider 调用的请求/响应/耗时摘要，只能去看 `_logs` 字符串。

## 当前证据

- `packages/runtime/src/plugin-runtime-gateway.ts:95–222` —— `commonOptions()` 只包含 `apiKeys / traceId / slotOverrides`，没有 emitter。
- `apps/server/src/routes/api/plugin-rpc.ts:285` —— `createTurnEmitter(...)` 已建好，但仅传给 `executeTurn`，function runtime 的 follower 路径完全不接 emitter。
- `apps/server/src/routes/api/plugin-rpc.ts:441–446` —— `runDeferredFollower` 没有 emitter 参数，handler 调用 `ctx.gateway` 时无法把 trace 写回去。

## 实施方案

1. 在 `createPluginRuntimeGateway()` 增加可选 emitter / 上下文：
   ```ts
   interface PluginRuntimeGatewayConfig {
     readonly emitter?: TurnEmitter;
     readonly emitterContext?: {
       readonly sessionId: string;
       readonly turnId: string;
       readonly pluginId: string;
       readonly runtimeId: string;
     };
     // …existing fields
   }
   ```
2. 在 `generateText / generateImage / generateObject` 入口前后写：
   - `provider.calling`：method、presetId、prompt hash（避免 PII）、providerRequestMetadata 摘要。
   - `provider.responded`：finishReason、usage、image count、durationMs。
   - `provider.failed`：error.message、durationMs。
3. 在 `apps/server/src/routes/api/plugin-rpc.ts`：
   - sync 路径：把当前 `emitter` 传给 `createPluginRuntimeGateway` 的 per-turn 实例（需要重构成"每轮再 wrap 一次"，因为 emitter 是 turn-scoped）。
   - background follower 路径：在 `runDeferredFollower` 内重建 emitter（已有 `args.followerTurnId`），构造一个新的 `createPluginRuntimeGateway({ ...config, emitter, emitterContext })`，再传给 handler 的 ctx.gateway。
4. 协议层加新事件 type：`provider.calling` / `provider.responded` / `provider.failed`，更新 `docs/reference/protocol.md`。
5. 测试：
   - `packages/runtime/tests/plugin-runtime-gateway.test.ts` 验证 emitter 调用次数 / 内容。
   - `apps/server/tests/api/plugin-rpc.test.ts` 验证 background follower 路径写入了 provider trace。

## 风险

- `createPluginRuntimeGateway` 当前是 server bootstrap 时构造一次，如果改成每轮重建会涉及 `app.ts` / `per-request-llm.ts` / `plugin-rpc.ts` 多处。建议在 facade 层加一个 `withEmitter(emitter, ctx)` 工厂方法，避免重新分配长生存周期对象。
- prompt hash 写 trace 要避免直接落 PII：摘要前先做 sha256 截断或仅保留长度+type。

## 验收标准

- 点击生成图片后 `/api/traces/:sessionId` 能看到 `provider.calling`（method=generateImage）和 `provider.responded`（含 image count、durationMs）。
- 失败路径写入 `provider.failed` 且包含 provider 返回的错误消息（去掉敏感字段后）。
- 现有 trace_events 测试无回归。

## 参考文件

- `packages/runtime/src/plugin-runtime-gateway.ts`
- `packages/runtime/src/turn-emitter.ts`
- `apps/server/src/routes/api/plugin-rpc.ts`
- `apps/server/src/routes/api/traces.ts`
- `docs/reference/protocol.md`
