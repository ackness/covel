# `llm.toml` Slot 配置参考

第三方插件**不修改 llm.toml 本身**——只在 README 里告诉用户怎么配。本文是给你写 README + handler 错误信息时的对照表，是 SDK 级合约，不需要看框架源码。

> 框架对这份 schema 用 Zod **strict** 模式：未声明字段 / 错枚举值会让**整份** llm.toml 拒载。
> **承诺**：所有字段、所有枚举值都已穷举。schema 改了但本文没改 = skill 的 bug。

## 完整字段表

```toml
[covel.<slot-name>]                # slot-name 任意小写串，惯例用 plugin id
provider = "<provider-id>"         # 必填；string 任意，按 {PROVIDER}_API_KEY 找 key
model    = "<model-id>"            # 必填
baseUrl  = "https://..."           # 必填；必须合法 URL
protocol = "openai-chat-v1"        # 必填；enum 见下

# ── 以下全部可选 ───────────────────────────────────────
fallback        = "<another-slot-name>"   # slot 失败时回退
tag             = "speech"                # capability tag；省略时按 output 自动推断（见踩雷点 #1）
output          = ["audio"]               # 模型 output modality；缺省时按 known-models DB 推断
input           = ["text", "image"]       # 模型 input modality
features        = ["function_calling", "streaming"]
contextWindow   = 131072
maxOutputTokens = 8192
embeddingFormat = "openai"                # 仅 embedding slot 用
reasoning_effort = "medium"               # reasoning 模型用
[covel.<slot-name>.thinking]
type = "enabled"                          # 'enabled' | 'disabled'
[covel.<slot-name>.pricing]
inputPerMToken      = 0.27
outputPerMToken     = 1.10
imageInputPerMToken = 0
audioInputPerMToken = 0
audioOutputPerMToken = 0
perImage             = 0
[covel.<slot-name>.providerRequestMetadata]
# 任意 key=value，merge 到 provider 请求 body（per-call metadata 优先级更高）
enable_thinking = true
```

## 枚举字段——填错就 ZodError，整份 toml 拒载

| 字段 | 允许值 |
|---|---|
| `protocol` | `"openai-chat-v1"` / `"openai-responses-v1"` / `"anthropic-messages-v1"` |
| `output[]` | `"text"` / `"image"` / `"audio"` / `"embedding"` |
| `input[]` | `"text"` / `"image"` / `"audio"` / `"video"` / `"file"` |
| `features[]` | `"function_calling"` / `"structured_output"` / `"streaming"` / `"reasoning"` / `"vision"` / `"prompt_caching"` / `"web_search"` / `"computer_use"` |
| `embeddingFormat` | `"openai"` / `"nemotron-multimodal"` |
| `reasoning_effort` | `"low"` / `"medium"` / `"high"` |
| `thinking.type` | `"enabled"` / `"disabled"` |

> **后果严重**：strict zod 单字段 schema fail → 整份 `llm.toml` 拒载，**所有** slot（包括与你无关的 `[covel.story]`）一起停摆。Server 启动时会回退到内置 DeepSeek `story` 兜底，但用户看到的现象是"我配的别的 provider 都没生效"。

## 踩雷点（第三方插件作者必须在 README 里教用户）

### 1. `tag` 自动推断**只产 `text` 或 `image`**

框架按 `output` 推断 `tag` 的规则：

- `output` 含 `"image"` → tag = `"image"`
- 其它情况 → tag = `"text"`

**音频 / 嵌入 / 转录 slot 不会被自动推到对应 tag**，必须手动写：

| Modality | 必须写的 `tag` |
|---|---|
| `output = ["audio"]` | `tag = "speech"` |
| `output = ["embedding"]` | `tag = "embedding"` |
| input 含 `audio`（语音转文字） | `tag = "transcription"`（plus 传 fallbackTag 时这么找） |
| `output = ["text"]` | 可省，自动推断 |
| `output = ["image"]` | 可省，自动推断 |

不写的话你 handler 里 `gateway.resolveSlot({fallbackTag: 'speech'})` 找不到这个 slot。

### 2. `output = [""]` / `tag = ""` 不是空——是 enum 拒绝

```toml
output = [""]   # ❌ z.enum 拒空字符串
tag    = ""     # ❌ z.string().min(1) 拒空（等价于 undefined）
```

**正确**：留空就直接**删掉这一行**，让 schema 走默认（缺省 = `optional`）。

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
       status: 'failed',
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
       status: 'failed',
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
