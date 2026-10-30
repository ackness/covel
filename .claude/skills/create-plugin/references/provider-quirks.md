# Provider 自管 Wire 指引

本页帮助插件作者选择模型接口、实现非标准协议。模型、地址和凭据由玩家配置；插件只声明用途和协议实现。完整契约见[插件扩展与通信](../../../../docs/reference/plugin-extensions.md#用已有的模型能力)和[模型用途](../../../../docs/reference/slots.md)。

## 决策树

- 文本：函数和 guard 都可以调用 `ctx.gateway.generateText` / `generateObject`。结构化输出传 JSON Schema；不必为了调用模型而改成 agent runtime。
- 图像：使用 `ctx.images.generate` 或 `ctx.gateway.generateImage`。
- 语音和转写：使用 `ctx.speech.generate` / `transcribe`。
- 音乐：使用 `ctx.music.generate`，由插件提供音乐 wire。
- 已有协议不支持的文本、图像、语音、转写或音乐：在 entry 注册对应的 wire，而不是在业务 handler 里另写一条 provider fetch 路径。
- embedding 不走文本 wire；视频也没有可供插件注册的 wire 接口。不要把一个普通服务注册成框架尚未支持的模型能力。
- 服务商先返回任务 ID、再轮询结果时，轮询属于 wire 的实现，并受同一个取消信号约束。

## 自管 wire 标准模板

wire 和业务 handler 分开。entry 用 `covel.registerWires({ text, image, speech, transcription, music })` 注册实现，只写需要的类型；各实现的本地 `id` 同时列入 `contributes.wires`。文本模型的 `protocol` 用 `<pluginId>/<wireId>`。

精确签名从公开 SDK 的 `PluginTextWire`、`PluginImageWire`、`PluginSpeechWire`、`PluginTranscriptionWire`、`PluginMusicWire` 取得。文本 wire 的可复制示例在[文本协议 wire](../../../../docs/reference/plugin-extensions.md#文本协议-wire)，媒体的路由和结果在[模型用途](../../../../docs/reference/slots.md)。

- 使用传入的 `config`，不要在 wire 里选择另一台服务商、硬编码模型或查找其他槽位的密钥。
- HTTP 使用 `covel.http.fetchWithRetry`，传递 `config.signal`。社区插件只能访问声明的源和方法，以及当前用途的端点；重定向也要通过检查。
- 返回 SDK 规定的内容、用量和警告。媒体由宿主存入 MediaStore，业务 handler 保存 `MediaRef`。
- 不为旧开发版本添加 `framework too old` 分支；按当前契约实现并声明所需宿主版本。

## 鉴权头差异表（常见 provider）

鉴权属于 wire 协议，不属于 runtime 提示词。按服务商当前的官方文档和已验证请求实现，不在本技能维护另一份供应商字段表。

只向 `config.baseUrl` 所代表的服务发送 `config.apiKey` / `headers`。密钥不进入提示词、返回值、日志、示例数据或错误说明。没有密钥的本地端点可以合法工作，不要对所有端点强制要求 key。

## Body 形态差异表（常见踩雷）

wire 负责把 SDK 的模型请求转换成服务商协议。文本 wire 必须处理消息、工具、结构化回复要求和取消，并同时实现 `generateText` 与 `streamText`。不要通过把所有 system 消息移到最前面来简化实现；这会改变上下文顺序和缓存行为。

## 响应解析差异表

以公开 SDK 的返回类型为准。文本流必须以 `done` 事件结束；服务商的结束原因由网关统一。媒体 wire 返回字节或接口允许的 URL，不把 base64 存进 plugin data。

## 排查不熟悉 provider 的标准流程

1. 先阅读服务商当前的官方协议和 SDK 示例，明确端点、鉴权、请求和结束原因。
2. 用 mock 固定请求转换、成功结果、4xx/5xx、取消、超时和损坏响应。异步协议还要覆盖轮询期限及终态。
3. 只有任务已授权且有可用凭据时才做真实请求。保留脱敏复现步骤，不在注释或命令里留下真实 key。
4. 错误给出可操作的分类和建议；不要把原始响应正文直接放进玩家可见的错误。它可能含凭据或私有数据。

## 推荐的 lib/ 布局

```text
my-plugin/
├── PLUGIN.md
├── server/index.js
├── lib/provider-wire.js
└── runtimes/
    └── generate/
        ├── RUNTIME.md
        └── handler.js
```

wire helper 测试通过注入 HTTP mock 验证协议；runtime 测试 mock `ctx.images` / `ctx.speech` 等公共能力，验证业务输入、`MediaRef` 和待提交 effects。entry 注册只在根文件声明，不能在子目录放 `PLUGIN.md`。

## 失败处理通用范式

用 `ctx.progress.report({ jobId, state: "running", sequence: 1 })` 发布执行进度。成功时把领域结果放进 `effects.pluginData` 和 `effects.assetGenerations`；失败时报告失败进度并返回 `outcome: "failed"`。同一 job 的 `sequence` 递增。失败和跳过结果不提交领域写入，不用它们保存错误占位。

取消信号继续向下传递。框架不能强行终止同进程 JavaScript，也不能撤回已发出的外部请求；不要把取消改写成成功。

## 流式响应（参考）

文本 wire 按 SDK 的流事件契约实现。runtime 是否把正文流给玩家，由循环 profile 和 Hook 决定。不要用 job-status 通道代替叙事协议，也不要承诺前端可以直接播放 PCM 帧；当前媒体接口交付完成的媒体引用。结构化请求的解析和 schema 校验由网关负责。
