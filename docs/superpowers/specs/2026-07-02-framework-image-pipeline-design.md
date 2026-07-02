# 框架统一图像管线（Framework Image Pipeline）设计

> GalGame 对话模式四部曲的底座（D），先于 A（场景资产管线）/ B（场景解析）/ C（舞台 UI）实施。
> 目标：图像生成成为**框架基本功能**——第三方插件只编排 prompt 与时机，不再各自手写 HTTP；不同协议的模型接入同一管线；框架按用途统一管理产出的图像资产。

## 现状与缺口

**已有（保持不动，管线在其上组装）**：

- slot/tag 体系：`tag: image` 的槽位、跨 tag fallback 禁止、模型能力（`output: ["image"]`）、逐请求 `X-Provider-Keys` / desktop `keys.env` 密钥流。
- `ctx.gateway.resolveSlot()`：插件侧凭证/模型解析（现状插件拿到后自己 fetch）。
- `ctx.media`：put/get/resolveUrl/ingestUrl（含 SSRF 防护）。
- `asset.generate` 提案 + commit 管线 + 强制校验（image-generation capability 的 runtime 必须产出 asset.generate、plugin_data 禁止内联 base64，见 `session-asset-output.ts`）。
- 媒体库（sha256 寻址）、画廊、签名 URL。

**缺口（本规格要补的）**：

1. gateway 只有文本/chat 协议 adapter，无图像生成 operation → 每个图像插件手写 endpoint/响应解析/重试（openai-image-gen ~100 行、dashscope-image-gen 自持 submit+poll 全套）。
2. 无按用途（场景/人物/变体）的统一资产查询面——metadata 散落在各插件自己的 plugin_data namespace。
3. 离线脚本（generate-portraits.mjs）也在手写同一套 wire。

## 范围

**做**：D1 gateway 图像 operation + 协议 adapter；D2 插件运行时一级 API（ctx.images）；D3 MediaRef metadata 约定 + 查询面；两个第三方示例插件（openai-image-gen / dashscope-image-gen）迁移到新 API；generate-portraits.mjs 改走同一实现；文档同步。

**不做**：agent runtime 的 builtin `generate-image` 工具（当前图像插件全是 function runtime，YAGNI，接口留得住即可）；图像编辑/inpainting（同一管线将来可扩 operation）；A/B/C 的内容本身。

## D1 gateway 图像 operation（packages/ai-provider）

```ts
gateway.generateImage(input: {
  presetId?: string;           // slot 名，缺省走 image tag 解析（现有 tag-aware fallback）
  prompt: string;
  negativePrompt?: string;
  size?: string;               // "1536x1024"
  quality?: string;
  n?: number;
  background?: "transparent" | "opaque";  // 不支持的协议忽略并在结果里标注
}, options?): Promise<{
  images: Array<{ bytes: Uint8Array; mime: string }>;
  model: string; providerId: string;
  usage?: { costUsd?: number };
  warnings?: string[];         // 如 "background=transparent unsupported, prompt-only"
}>
```

- **协议 adapter**（与文本 adapter 同层，按 provider protocol 分发）：
  - `openai-images`：`POST {base}/v1/images/generations`（兼容裸 base 与 /v1 双形态——沿用 openai-image-gen 已验证的 endpoint 归一逻辑），同步返回 b64/url。
  - `dashscope-images`：wan2.x 异步 wire——submit task → poll 至 SUCCEEDED/FAILED（迁移 dashscope-image-gen 已验证的实现）。
  - adapter 接口统一为"一次调用返回最终图"，async-poll 细节封装在 adapter 内；超时沿用调用方传入的 signal。
- 密钥/授权：复用现有 per-request keys 与 SSRF guard（`validateBaseUrl`）；不新增任何密钥存储。
- trace：产出 `gateway.responded` trace（含 costUsd），进现有 Cost 页聚合。

## D2 插件运行时一级 API（packages/runtime）

function runtime ctx 新增 `ctx.images`：

```ts
ctx.images.generate(input /* 同 D1 + metadata */): Promise<{ ref: MediaRef; warnings?: string[] }>
```

- 框架内部：D1 生成 → `ctx.media.put()` 落媒体库 → 回填 metadata（见 D3）→ 返回 MediaRef。**插件全程不接触字节流与凭证**。
- 插件仍照旧提交 `asset.generate` / plugin.data(ref) 提案——现有强制校验（禁内联 base64）不变，且从"约束"变成"顺理成章"（插件手里只有 ref）。
- `ctx.gateway.resolveSlot()` 保留（向后兼容 + 特殊需求逃生口），文档标注"图像生成请优先 ctx.images"。

## D3 统一资产管理

- **MediaRef metadata 约定**（生成时由框架写入，插件通过 generate 的 metadata 参数补充业务字段）：

```jsonc
{
  "kind": "scene-background" | "character-sprite" | "illustration" | ...,
  "sceneId": "...",            // 或 characterId，按 kind
  "variant": "day" | "night",
  "pluginId": "...",           // 框架自动注入
  "promptHash": "sha256(...)"  // 框架自动注入，防重复生成
}
```

- **查询面**：MediaStore 新增 `listByMetadata(sessionId, filter: Partial<meta>)`（四后端 + 契约测试；SQL 后端按 JSONB/JSON1 查询，memory/idb 内存过滤即可——媒体量级小）。
- 查图优先级统一为：**世界包注册表 → 会话 media store（listByMetadata）→ 调用方回退链**。B/C、画廊、A 的"保存到世界级"都走这一个查询面。
- `promptHash` 命中时 `ctx.images.generate` 直接返回已有 ref（幂等，防止重试风暴重复扣费）。

## 迁移

- `~/.covel/plugins/openai-image-gen`、`dashscope-image-gen`：删除手写 wire（imagesEndpoint/postOpenAiImages/submitTask/poll ~300 行），改调 `ctx.images.generate`；行为验收 = 现有插件测试全绿 + 画廊出图不变。
- `scripts/generate-portraits.mjs`：改由 tsx 运行并 import ai-provider 的 image adapter（wire 单一实现）；llm.toml/keys.env 读取逻辑保留在脚本（离线场景无 server）。A 的 generate-scenes.mjs 直接按此形态新建。

## 回退与错误

- 图像 slot 未配置 → `generateImage` 抛带明确信息的错误；调用方（插件/脚本）按各自回退链处理，**不阻塞对话回合**（插件本就 background 执行）。
- adapter 不支持的参数（如 transparent）→ 降级为提示词方案 + warnings 标注，不失败。
- 生成失败 → 现有插件级错误呈现（画廊错误卡片）不变；`maxRetries` 语义由调用方 userSettings 保留。

## 验收

- 两个第三方插件迁移后测试全绿、画廊功能不变、代码量净减。
- `pnpm --filter @covel/ai-provider test`、`@covel/store` 契约（listByMetadata）、`@covel/runtime`（ctx.images）新用例全绿。
- 文档：docs/reference/tools.md（ctx.images）、docs/guide/plugin-authoring.md（图像插件契约改写）、docs/reference/media-store.md（metadata 约定 + 查询面）。

## 决策记录

1. 生成执行收进框架（gateway operation + 协议 adapter），插件只编排——用户定调"图像生成是框架基本功能"。
2. adapter 统一"一次调用返回最终图"，async-poll 封装在 adapter 内（DashScope wan2.x 实测 wire 直接迁移）。
3. `promptHash` 幂等去重由框架承担（60-180s/张 + 计费，重复生成代价高）。
4. resolveSlot 逃生口保留，不做破坏性下线。
5. builtin 工具、图像编辑 operation 均 YAGNI 后置。
