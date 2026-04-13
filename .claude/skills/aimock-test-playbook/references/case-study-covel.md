# 案例：COVEL 如何接入这套分层思路

这只是案例，不是 skill 的默认叙事方式。只有在仓库就是 COVEL，或用户明确要看具体案例时才读取。

## 1. provider 边界

- `apps/server/src/ai-setup.ts`
- `packages/ai-provider/src/provider-registry.ts`
- `packages/ai-provider/src/adapters/http.ts`
- `packages/runtime/src/gateway-llm-adapter.ts`

结论：

- `aimock` 的最佳接入层是 `packages/ai-provider`
- runtime 编排层在大多数情况下继续使用 fake LLM 更合适

## 2. 已经适合继续 fake 的测试

- `apps/server/tests/api/__helpers/fake-llm.ts`
- `apps/server/tests/api/e2e-narrator.test.ts`
- 多数 `apps/server/tests/api/*`
- 多数 `packages/runtime/tests/*`

这些测试主要验证路由、状态流、调度以及 proposal 提交，通常不需要引入 `aimock`。

## 3. 最适合迁到 replay 的测试

- `packages/ai-provider/tests/live/deepseek.test.ts`
- `packages/ai-provider/tests/live/dashscope.test.ts`

这些测试正好位于 provider HTTP 边界。

## 4. 最适合降成 opt-in live 的重型测试

- `tests/e2e/game-session.spec.ts`
- `tests/e2e/ai-world-gen.spec.ts`
- `scripts/test-real-llm.ts`
- `scripts/test-real-llm-sqlite.ts`
- `scripts/test-full-3plugins.ts`

## 5. baseUrl override

在 COVEL 中，最直接的覆盖方式是环境变量：

```bash
DEEPSEEK_BASE_URL=http://127.0.0.1:4010/v1
DASHSCOPE_BASE_URL=http://127.0.0.1:4010/v1
```

原因：

- `.env.llm.example` 已支持 `*_BASE_URL`
- `llm.toml.example` 也允许 slot 级 `baseUrl`
- `http.ts` 允许 `localhost`

## 6. 一个值得注意的限制

`packages/ai-provider/src/config/llm-schema.ts` 当前的 slot schema 还不支持 `headers`。

因此：

- 普通 replay：只改 `baseUrl` 通常够用
- 更细粒度的 per-test header 隔离：更适合在测试代码里以编程方式创建 gateway/provider config
