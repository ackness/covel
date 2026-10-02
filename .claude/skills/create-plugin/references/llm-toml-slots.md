# `llm.toml` Slot 配置：插件作者踩雷点

第三方插件**不修改 llm.toml 本身**——只在 README 里告诉用户怎么配。本文只收集写 README 和 handler 错误信息时容易踩的坑。

**字段全集、枚举值和默认值以 [`docs/reference/slots.md`](../../../../docs/reference/slots.md) 为准**（schema 源码：`packages/ai-provider/src/config/llm-schema.ts`）。不要在这里或插件 README 里另抄一份字段表：schema 是 Zod **strict**，抄错一个枚举值，用户照着填会让**整份** `llm.toml` 拒载——所有 slot（包括与你无关的 `[covel.story]`）一起停摆，服务端回退到内置 DeepSeek `story`，用户看到的现象是"我配的别的 provider 都没生效"。

## 踩雷点（第三方插件作者必须在 README 里教用户）

### 1. 只有转写 slot 必须手写 `tag`

省略 `tag` 时，框架按 `output` 推断（`modelOutputTag`，`packages/shared/src/model-capabilities.ts`）：

- `output` 含 `"evaluation"` → `evaluation`
- 含 `"image"` → `image`
- 含 `"audio"` → `speech`
- 含 `"embedding"` → `embedding`
- 其它 → `text`

**语音转文字模型例外**：它的 output 是 `text`，会被推成 `text`，必须手写 `tag = "transcription"`，否则 handler 里 `gateway.resolveSlot({ fallbackTag: "transcription" })` 找不到这个 slot。

### 2. 空字符串不等于"没写"

```toml
output = [""]   # ❌ 不在 enum 里，整份 llm.toml 拒载
tag    = ""     # ❌ schema 接受，但得到空 tag：不会回落到按 output 推断，按 tag 找不到这个 slot
```

**正确**：不想设置就直接**删掉这一行**，让框架走默认推断。

### 3. baseUrl 末尾的 `/v1` 取决于 provider

OpenAI 兼容 host：写 `baseUrl = "https://api.example.com"` ——adapter 自己拼 `/v1/chat/completions`。
某些 provider 文档会让你写 `https://x.example.com/v1` ——也行，但不同 wire 实现对重复 `/v1` 的处理不一致。

**插件作者**自管 wire 时建议写**容错**：

```js
const trimmed = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
const url = `${trimmed}/v1/chat/completions`;
```

### 4. `description` / `i18n` 字段是 string，**不是** I18nText 对象

`PLUGIN.md` 的 `description:` 是 string。如果你按 i18n 习惯写：

```yaml
description:
  zh: 中文
  en: English
```

会直接 ZodError 拒载。统一写一行 string，必要时混合中英文。完整字段定义见 [`plugin-schema.md`](./plugin-schema.md)。

## API key 解析规则

```
keys.env 里：DEEPSEEK_API_KEY=sk-...
        ↓ 转换：去 _API_KEY 后缀，lowercase，下划线 → 连字符
slot 配置里 provider = "deepseek"  → apiKeys["deepseek"] 命中
```

```
XIAOMI_API_KEY     ↔ provider = "xiaomi"
DEEPSEEK_API_KEY   ↔ provider = "deepseek"
DASHSCOPE_API_KEY  ↔ provider = "dashscope"
OPEN_ROUTER_API_KEY ↔ provider = "open-router"  (下划线变连字符！)
```

**给用户写 README 时**：明确说 "环境变量名必须叫 `<UPPER>_API_KEY`，对应 slot `provider = "<lower>"`"。

## 插件 → slot 对接惯例

第三方插件应该：

1. **默认 presetId 等于插件 id**（避免与别人撞名）

   ```yaml
   # PLUGIN.md
   userSettings:
     - key: modelPresetId
       type: text
       default: mimo-tts            # ← 插件 id
       label: 模型 preset
   ```

2. **handler 用 `fallbackTag`** 让没配 slot 的用户至少能 fallback：

   ```js
   const slot = ctx.gateway.resolveSlot({
     presetId: userSettings?.modelPresetId ?? 'mimo-tts',
     fallbackTag: 'speech',
   });
   ```

3. **README 给完整样例**，把 `tag` / `output` 都写出来：

   ```toml
   [covel.mimo-tts]
   provider = "xiaomi"
   model    = "mimo-v2.5-tts"
   baseUrl  = "https://api.xiaomimimo.com"
   protocol = "openai-chat-v1"
   tag      = "speech"          # ← 必写！自动推断不会到这
   output   = ["audio"]         # ← 必写！known-models DB 不一定有这个 model
   ```

4. **handler 错误信息要 actionable**：

   ```js
   if (!slot) {
     return {
       outcome: 'failed',
       error: `Slot "${presetId}" not configured. Add to ~/.covel/llm.toml:
[covel.${presetId}]
provider = "..."
model    = "..."
baseUrl  = "..."
protocol = "openai-chat-v1"
tag      = "speech"
output   = ["audio"]`,
     };
   }
   if (!slot.apiKey) {
     return {
       outcome: 'failed',
       error: `Slot resolved without apiKey — set ${slot.provider.toUpperCase().replace(/-/g, '_')}_API_KEY in ~/.covel/keys.env`,
     };
   }
   ```

## SSRF 真相

框架的 SSRF 策略：**Open by default**。所有公网 https host 默认放行。**block** 仅这些：

- RFC1918 / link-local IP（`10.x` / `172.16-31.x` / `192.168.x` / `169.254.x` / `fc00::` / `fe80::`）
- Cloud metadata host：`metadata.google.internal`、`metadata.internal`
- 远程 host 用 http（必须 https）
- 非 `http`/`https` 协议
- Loopback（`localhost` / `127.0.0.1` / `::1`）：可以 http，给 Ollama 等本地服务用

**`COVEL_ALLOWED_LLM_HOSTS`** 这个 env var 仅作占位文档存在——**代码并不读**。第三方插件作者**不需要**让用户加这个 env，把任何公网 https host 写进 `baseUrl` 都直接通过。

## 调试

启动时 schema fail 会在 server log 报：

```
ZodError: Invalid input
  - covel.mimo-tts.output.0: Invalid enum value. Expected 'text' | 'image' | 'audio' | 'embedding', received ''
```

**给 user 的排查 tips**（写进插件 README 的"安装后排查"小节）：

1. 启动后看 server log 里第一行 LLM 加载日志，是否报 ZodError——有就按上面错误位置改字段
2. 在前端 Settings → LLM 页面看是否能列出本 slot——列不出基本就是 schema 失败
3. handler 报 `Slot "<X>" not configured` → 检查 section 名是否拼对、是否落在 `[covel.X]` 命名空间
