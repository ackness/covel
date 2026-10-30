# `llm.toml` Slot 配置：插件作者踩雷点

插件只在 `agent.model` / `function.model` 写模型用途名。玩家在设置界面或 `llm.toml` 里把用途连到服务商与模型；插件目录里的 `llm.toml` 不会被读取。

字段、默认值、回退和优先级以[模型用途](../../../../docs/reference/slots.md)为准，schema 在 `packages/ai-provider/src/config/llm-schema.ts`。不要在技能或插件 README 复制完整字段表。配置出错时，启动使用内置默认配置并报告错误；手动重载失败则保留正在使用的配置。

## 踩雷点（第三方插件作者必须在 README 里教用户）

<a id="1-只有转写-slot-必须手写-tag"></a>

### 1. 转写和音乐用途需要明确 `tag`

`modelOutputTag` 按输出类型推导用途标签，优先顺序是 evaluation、image、audio（推成 speech）、embedding，最后是 text。转写模型输出 text，但用途是 transcription，所以必须显式标为 `transcription`；音乐也需要 `music`，否则 audio 被推成 speech。

设置中的用途标签和输出能力要相符。完整规则见[模型用途](../../../../docs/reference/slots.md#slot-字段covelslot)，不要把 `tag`、模型输出类型和插件契约混为一谈。

### 2. 空字符串不等于"没写"

不设置的字段直接省略，不写 `output = [""]` 或 `tag = ""`。schema 不接受的字段会使整份配置校验失败；合法但空的自定义标签也不会自动变成推导标签。

### 3. baseUrl 末尾的 `/v1` 取决于 provider

使用内置协议时，按[连接端点](../../../../docs/reference/slots.md)的规则填写地址。业务 handler 不拼 provider URL。自定义 wire 才负责地址到协议路径的转换，并对自己支持的根路径和后缀写测试；不要把一种 `/v1` 处理规则推广给所有协议。

### 4. 清单里的标签只写 English，译文放 `locales/`

`PLUGIN.md` 的 `displayName`、`description` 和 `label` 用 English 字符串，不写内联语言 map。译文按清单文件分节：

```yaml
PLUGIN.md:
  description: 中文说明
```

动态文本用 `translate` / `labelText`，详见[多语言](../../../../docs/reference/i18n.md)。

## API key 解析规则

密钥属于玩家配置，不属于插件。源码运行从 `.env.llm`、桌面版从 `keys.env` 读取；Web 客户端也可随请求提供密钥。环境变量按 `{PROVIDER}_API_KEY` 命名，下划线映射成 provider 名中的连字符，例如 `OPEN_ROUTER_API_KEY` 对应 `open-router`。

完整优先级和 origin 限制见 [API Key 流转](../../../../docs/reference/slots.md#api-key-流转)。服务的 `gateway.resolveSlot` 不向服务提供者泄露调用方凭据；wire 只处理宿主交给它的当前端点配置。

## 插件 → slot 对接惯例

- 固定用途写在 `agent.model` 或 `function.model`。需要玩家选择时，在 `contributes.settings` 声明 `type: slot` 的设置，并限制适用 tag。
- 使用 `ctx.gateway`、`ctx.images`、`ctx.speech`、`ctx.music`，不要在 handler 中绕过媒体路由自行 fetch。
- 需要 `resolveSlot({presetId, fallbackTag})` 时只请求与工作相符的 tag；回退不跨类型。不要依赖默认文本模型来完成图片、语音或转写。
- README 说明用途、所需协议和配置失败后怎么修复；不要固定一个供应商或要求任何端点都必须有 key。
- 插件不改玩家的 `llm.toml`，不写密钥，也不创建旧式根 `userSettings` 字段。

## SSRF 真相

服务端默认允许公网 HTTPS，仍执行地址、DNS 和重定向检查。provider 路由按部署形态处理本地模型；插件的 HTTP helper 则始终走严格的直连路径，还受声明的源和方法约束。两条路径不是同一种访问权限。

不要建议未注册的环境变量或关闭安全检查。完整边界见[安全](../../../../docs/internals/security.md#outbound-requests-ssrf-guard)和[环境变量](../../../../docs/reference/env-registry.md)。

## 调试

先看设置界面报告的配置错误和服务端的脱敏日志，再检查：用途是否存在、tag 与能力是否匹配、协议插件是否已启用并获准运行、当前 origin 是否可以使用该凭据。

重载失败不会覆盖正在使用的配置。插件应把不可用用途报告为明确失败或跳过，不伪造成功产物。仅在已有授权和凭据时验证真实模型；常规测试用 mock，不要求模型 key。
