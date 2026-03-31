# AI Provider + Runtime 实现计划

## Context

Covel 需要一个统一的 AI 提供者层，为系统中所有 LLM 操作提供服务。当前 worktree (v0) 只有基础的 Hono 服务器和共享类型，尚无 AI 调用能力。主仓库的 `modules/model-gateway/src/` 是成熟的参考实现，需要移植并增强。

**用户确认**:
- Runtime 独立为 `packages/runtime`
- 测试厂商: DeepSeek + DashScope（均 OpenAI 兼容）
- 第一轮只做 HTTP + SSE，WebSocket 后续迭代

---

## 包结构

### 1. `packages/ai-provider/` — AI 提供者

```
packages/ai-provider/
├── package.json          # @covel/ai-provider
├── tsconfig.json
├── src/
│   ├── index.ts          # 公共导出
│   ├── types.ts          # ProviderConfig, StreamEvent, OperationMode, ModelTier 等
│   ├── errors.ts         # AiProviderError (code, retriable, provider)
│   │
│   ├── config/
│   │   ├── loader.ts     # TOML 加载 + ${ENV} 插值 (smol-toml)
│   │   └── schema.ts     # Zod schema (PresetConfig, ProviderDefaults 等)
│   │
│   ├── adapters/
│   │   ├── adapter.ts    # ModelProviderAdapter 接口定义
│   │   ├── http.ts       # postJson, iterateSse, buildUrl 等共享工具
│   │   ├── openai-chat.ts        # OpenAI Chat Completions v1
│   │   ├── openai-responses.ts   # OpenAI Responses v1
│   │   └── anthropic-messages.ts # Anthropic Messages v1
│   │
│   ├── provider-registry.ts  # provider name → adapter + config 解析
│   ├── preset-registry.ts    # 预设解析、tier 映射、fallback 链
│   ├── gateway.ts            # 高层网关: generateText/Object, streamText, embed, generateImage, synthesizeSpeech, transcribeAudio
│   │
│   └── trace/
│       ├── context.ts    # TraceContext 类型 (traceId, runId, turnId, runtimeId...)
│       └── langfuse.ts   # Langfuse lifecycle hook (可选)
│
├── presets/
│   └── default.toml      # 默认预设 (DeepSeek + DashScope)
│
└── tests/
    ├── config-loader.test.ts
    ├── preset-registry.test.ts
    ├── provider-registry.test.ts
    ├── gateway.test.ts
    └── live/
        ├── deepseek.test.ts
        └── dashscope.test.ts
```

### 2. `packages/runtime/` — Runtime 执行层

```
packages/runtime/
├── package.json          # @covel/runtime
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── executor.ts       # RuntimeExecutor: 组合 Provider + Context + Prompt
│   ├── prompt-builder.ts # RuntimeContextView → messages[]
│   └── budget.ts         # maxSteps/timeoutMs 硬限制, maxTokens 尽力
│
└── tests/
    ├── executor.test.ts
    ├── prompt-builder.test.ts
    └── budget.test.ts
```

### 3. `apps/server/` 新增路由

```
apps/server/src/
├── routes/ai/
│   ├── generate.ts       # POST /api/ai/generate (JSON)
│   └── stream.ts         # POST /api/ai/stream (SSE)
├── routes/config/
│   └── presets.ts        # GET /api/config/presets
└── middleware/
    └── api-key-injection.ts  # X-Provider-Keys header 解码
```

---

## TOML 预设格式

```toml
[providers.deepseek]
baseUrl = "${DEEPSEEK_BASE_URL}"
protocol = "openai-chat-v1"

[providers.dashscope]
baseUrl = "${DASHSCOPE_BASE_URL}"
protocol = "openai-chat-v1"

[[presets]]
id = "default"
name = "DeepSeek Chat"
provider = "deepseek"
model = "deepseek-chat"
tier = "medium"
supportedModes = ["text", "object", "stream"]
enabled = true
isDefault = true
fallbackPresetIds = ["fallback-dashscope"]

[[presets]]
id = "fallback-dashscope"
name = "DashScope Qwen"
provider = "dashscope"
model = "qwen-plus"
tier = "medium"
supportedModes = ["text", "object", "stream"]
enabled = true
```

`${VAR}` 从 process.env 插值。API Key 不写入 TOML，由请求头传入。

---

## API Key 流转

1. 浏览器 localStorage 存 `{"deepseek":"sk-...", "dashscope":"sk-..."}`
2. 请求头 `X-Provider-Keys: base64(JSON)`
3. Hono middleware 解码 → `c.set("apiKeys", parsed)`
4. Gateway 调用时合并到 ProviderConfig.apiKey
5. 请求结束后 key 仅存在于内存

---

## 流式输出

内部: `AsyncGenerator<StreamEvent>` (与参考实现一致)
传输: HTTP SSE `text/event-stream`，helper 函数转换 AsyncIterable → SSE frames

---

## 实现顺序

### Phase 1: ai-provider 包基础
1. 创建包结构 + package.json + tsconfig.json
2. `types.ts` — 核心类型
3. `errors.ts` — AiProviderError
4. `config/schema.ts` — Zod schema
5. `config/loader.ts` — TOML 加载 + env 插值
6. `config-loader.test.ts`

### Phase 2: Adapter + Registry
7. `adapters/http.ts` — 共享 HTTP 工具
8. `adapters/adapter.ts` — 接口定义
9. `adapters/openai-chat.ts`
10. `adapters/openai-responses.ts`
11. `adapters/anthropic-messages.ts`
12. `provider-registry.ts`
13. `preset-registry.ts`
14. 单元测试

### Phase 3: Gateway
15. `gateway.ts` — 7 方法 + fallback
16. `gateway.test.ts`
17. `index.ts` barrel export

### Phase 4: Trace
18. `trace/context.ts`
19. `trace/langfuse.ts`

### Phase 5: Runtime 包
20. 创建 `packages/runtime/` 包结构
21. `prompt-builder.ts`
22. `budget.ts`
23. `executor.ts`
24. 单元测试

### Phase 6: Server 集成
25. `middleware/api-key-injection.ts`
26. `routes/ai/generate.ts` (POST)
27. `routes/ai/stream.ts` (SSE)
28. `routes/config/presets.ts` (GET)
29. 路由注册到 app.ts

### Phase 7: Live 测试
30. `presets/default.toml`
31. `live/deepseek.test.ts`
32. `live/dashscope.test.ts`

---

## 依赖

| 包 | 新增依赖 |
|---|---|
| `@covel/ai-provider` | `smol-toml`, `zod`, `langfuse`, `@covel/shared` |
| `@covel/runtime` | `@covel/ai-provider`, `@covel/shared`, `zod` |
| `apps/server` | `@covel/ai-provider`, `@covel/runtime` |

---

## 参考文件

- 参考实现: `/Users/wuyong/codes/game/covel/modules/model-gateway/src/` (provider-registry.ts, runtime.ts, model-profile-registry.ts)
- 共享类型: `packages/shared/src/types/` (kernel.ts, plugin.ts, common.ts)
- 服务入口: `apps/server/src/index.ts`, `apps/server/src/app.ts`
- 架构文档: `docs/system-architecture-v0/`

## 验证

1. `pnpm install` 成功
2. `pnpm --filter @covel/ai-provider test` 通过
3. `pnpm --filter @covel/runtime test` 通过
4. 配置真实 key → live 测试通过
5. `curl -X POST /api/ai/generate` 返回 LLM 响应
6. SSE `/api/ai/stream` 可观察到逐 token 输出
