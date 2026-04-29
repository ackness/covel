---
name: create-plugin
description: 创建 Covel 插件。通过对话了解需求，直接生成 PLUGIN.md + package.json 写入 plugins/ 目录并验证。当用户想创建新插件、新游戏机制、新功能模块、或者说"帮我做一个 XX 系统"时触发。
user_invocable: true
---

# 创建 Covel 插件

根据用户需求，直接生成完整的插件文件并写入目标目录（默认 `plugins/`，用户指定第三方插件时写 `~/.covel/plugins/`）。

## 文档承诺：写插件不用读框架源码

`references/` 下的 4 份合约文档**承诺**覆盖第三方插件作者的所有需求：

- [`runtime-context.md`](references/runtime-context.md) — `ctx` 全字段（gateway/media/utils/pluginData/logger 等）+ handler 返回值 normalizeOutput 契约
- [`llm-toml-slots.md`](references/llm-toml-slots.md) — slot schema 全字段、所有枚举值、`tag` 自动推断踩雷点、apiKey 解析规则、SSRF 真相
- [`ui-components-quickref.md`](references/ui-components-quickref.md) — 36 个 UI 组件 + 全部 props + binding 语法（`$item` / `$state` / `repeat`）+ 5 个 `on.click.action`
- [`provider-quirks.md`](references/provider-quirks.md) — 自管 wire 决策树、鉴权头差异表、body 形态差异表、响应解析差异表

如果按上面 4 份文档生成的插件还需要去翻 `packages/`，那就是 skill 的 bug——**记下来再来修 skill**。

## 核心事实

- **插件 = 一组 Runtime**。每个 runtime 是一个独立调度单元，有自己的 `PLUGIN.md`（frontmatter + Markdown）。
  - 单 runtime：根目录只放一个 `PLUGIN.md`。
  - 多 runtime：把每个 runtime 放到 `runtimes/<sub>/PLUGIN.md`。框架自动扫描。**强烈建议**额外在根目录放一份**摘要级** `PLUGIN.md`（仅含 `name` / `description` / `pluginType`，**不**作为 runtime），框架用它做包级 displayName 和简介。**没有**根 PLUGIN.md 时 UI 会回退显示 plugin id（如 `dashscope-image-gen`），不直观。
- **Runtime 类型**
  - `agent`（默认）：LLM 驱动，正文就是 system prompt。支持 `model` slot。
  - `function`：纯 JS handler，不跑 LLM，由 `handler: ./handler.js` 指向入口。可访问 `ctx`（详见 [`runtime-context.md`](references/runtime-context.md)）。
- **触发**：`auto`（每轮）/ `manual`（仅 `POST /plugin-rpc`）/ `scheduled` / `event` / `error-retry`。
- **手动触发按钮**：UI JSON 里设 `on.click.action: "invokeRuntime"` + `params.runtimeId`，框架默认 handler 会自动 POST `/plugin-rpc`，插件**不需要**写 React 代码。所有 `on.click.action` 见 [`ui-components-quickref.md`](references/ui-components-quickref.md)。
- **同步 / 后台执行**（仅手动触发）：`execution: sync`（默认，阻塞 turn）/ `background`（202 + `jobId`，框架在 `_jobs/<jobId>` 写状态，前端通过 `plugin-data.changed` SSE 感知）。
  - 插件**禁止**主动写 `_jobs/*` / `_logs/*`，框架会覆盖。
- **事件链**：runtime 在返回里带 `events: [{topic, data}]`，下游 `trigger: {type: event, topic}` runtime 在同 turn 被拉起。
- **存储**：runtime 返回里带 `pluginData: [{namespace, key, value}, ...]`，框架自动转成 `plugin.data` / `plugin.data.batch` Proposal，写到 `plugin_data` 表 `(sessionId, pluginId, namespace, key)`。也可以用 `ctx.pluginData.set(...)` 立即落库（前端立刻通过 SSE 看到），适合 placeholder。
- **多媒体（图像 / 音频 / 视频 / 文件）**：用 `ctx.media`（不是 `pluginData` 直接塞 bytes）。`ctx.media.put(bytes, mime, meta) → MediaRef`；`ctx.media.ingestUrl(url, {allowedMimes})` 从 URL 拉取到 MediaStore。把 ref 写进 `pluginData.value.ref`，并在 runtime output 返回 `assets: [{ref, modality, meta}]` 让框架 emit `asset.generate` proposal。前端用 `<Media as="auto" ref={…}>` 渲染（自动按 mime 选 `<img>/<audio>/<video>/<a>` 控件）。完整契约见 [`runtime-context.md`](references/runtime-context.md) §`ctx.media`。
- **UI**：`ui: { right | message | left: [./ui/xxx.json] }` 指向 json-render spec。`dataSource.namespace` 让 spec 自动从本插件的 plugin-data 读数据。所有组件 + binding 见 [`ui-components-quickref.md`](references/ui-components-quickref.md)。
- **Gateway 不暴露的能力**：`ctx.gateway` 只有 `generateText` / `generateObject` / `resolveSlot`——**没有** `generateImage` / `generateAudio` / `embed` / `streamText`。图像 / 音频 / 视频 / embed / 转录一律 `resolveSlot` + 自管 wire，详见 [`provider-quirks.md`](references/provider-quirks.md)。

## 流程

### 1. 理解需求

用户说"做一个物品系统"或"我需要 NPC 对话引擎"。

如果需求清晰就直接开始。如果模糊，最多追问 1–2 个问题（技术参数自主推断）：
- 它在叙事之前还是之后执行？
- 需要玩家交互（按钮 / 表单 / 选择）吗？
- 是一个 runtime 还是需要拆成多个（例如：生成 prompt + 调模型 → 多 runtime）？

### 2. 读 references 再动手

**生成前必须读：**
- `references/plugin-schema.md` — 所有 frontmatter 字段、枚举值、默认值、strict schema 约束。

**按需读：**
- `references/example-plugins.md` — 现有插件完整样例。特别是 **dashscope-image-gen** 综合样例：多 runtime、手动按钮、`invokeRuntime`、事件链、function runtime + `ctx.gateway.generateImage`、`execution: background`、`userSettings`、UI 画廊。**任何涉及手动触发/按钮/图像/耗时任务的插件都应以这个样例为模板。**
- `references/tool-factory.md` — 自定义本地工具的工厂函数模式。

### 3. 生成文件

目录结构（按需裁剪）：

```
<plugins-root>/<plugin-id>/
├── package.json                      # 必须
├── PLUGIN.md                         # 单 runtime 必须；多 runtime 时可选（仅摘要：name/description/pluginType，作为包级 displayName）
├── runtimes/<sub>/PLUGIN.md          # 多 runtime:每个 runtime 一份
├── runtimes/<sub>/handler.js         # function runtime 必须
├── runtimes/<sub>/ui/*.json          # UI spec
├── tools/*.js                        # 自定义本地工具
├── hooks/*.js                        # 生命周期 hook
├── rpc/*.js                          # RPC action handler
└── schemas/*.json                    # output / tool schema
```

#### package.json

```json
{
  "name": "@covel/plugin-<id>",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

#### PLUGIN.md（agent runtime）

YAML frontmatter（strict 模式）+ Markdown 正文。正文就是 system prompt：

```markdown
# <角色定位，1-2 句>

## 职责
- <具体职责列表>

## 规则
- <行为约束和硬规则>

## 输出格式
<LLM 应该输出什么>

## 示例
<一个具体的输入→输出示例>
```

#### PLUGIN.md（function runtime）

function runtime 的正文不会被当 prompt，只用作说明文字。关键是 frontmatter 里：
- `runtimeType: function`
- `handler: ./handler.js`

handler 签名（**单参**，运行时只传 `ctx`）：

```js
export default async function handler(ctx) {
  // ctx.triggerEvent = {topic, data}  // event 触发时存在
  // ctx.manualPayload                 // manual 触发 (POST /plugin-rpc payload)
  // ctx.gateway                       // 调 LLM / 图像 (唯一入口)
  //   generateText / generateImage({ presetId, prompt, ... })
  //   generateObject 在 function runtime 里暂不可用(审计 F9);结构化 JSON
  //   输出改用 agent runtime 的 output.schema 路径。
  // ctx.config                        // 会话/世界级配置
  // ctx.completedResults              // 本 turn 前序 runtime 的 output (Map)

  // 返回普通 JSON。框架识别这些字段并走 commit pipeline:
  //   narrativeOutput | content      → narrative.append
  //   events: [{topic, data}]        → event.emit
  //   statePatches: [...]            → state.patch
  //   pluginData: [{namespace, key, value}] → plugin.data / plugin.data.batch
  //   interactions: [{type:'form', ...}]    → interaction.request
  //   notifications: [{title, message}]     → narrative.append(kind='system')
  // 其它字段作为 runtime output 持久化供下游 runtime 读取。
  return {
    events: [{ topic: 'my.topic', data: {} }],
    pluginData: [{ namespace: 'foo', key: 'bar', value: { ok: true } }],
  };
}
```

> **不要**在返回里写顶层 `proposals: [...]` — 那是工具层通过 Symbol 传递的内部
> channel，不是 handler 公开 API；外层 JSON 的 `proposals` 字段会被 normalizeOutput
> 忽略，等于没写。

### 4. 验证 schema(必做)

写完后必须跑 schema 校验（校验失败即修复重写）：

**仓库内插件（`plugins/<id>/`）：**

```bash
node --input-type=module -e "
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { validatePluginManifest, formatValidationErrors } from '@covel/shared';
const { data } = matter(readFileSync('plugins/<id>/PLUGIN.md','utf-8'));
const r = validatePluginManifest(data);
if(!r.valid){console.error(formatValidationErrors(r.errors));process.exit(1)}
console.log('OK');
"
```

**仓库外插件（`~/.covel/plugins/<id>/`）：** 同样脚本，但要在 `packages/plugin-loader/` 子目录执行（依赖 `gray-matter` + `@covel/shared`）：

```bash
cd packages/plugin-loader && node --input-type=module -e "
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { validatePluginManifest, formatValidationErrors } from '@covel/shared';
const HOME = process.env.HOME;
const { data } = matter(readFileSync(\`\${HOME}/.covel/plugins/<id>/PLUGIN.md\`,'utf-8'));
const r = validatePluginManifest(data);
if(!r.valid){console.error(formatValidationErrors(r.errors));process.exit(1)}
console.log('OK');
"
```

**多 runtime**：对每个 `runtimes/<sub>/PLUGIN.md` 分别跑一次。

### 5. 测试（按复杂度分层选）

参考 `references/plugin-testing.md`(必读) — 给出三层模板和决策树，照抄即可。简版决策：

| 你写了什么 | 至少要写哪些测试 |
|------------|------------------|
| 只有 PLUGIN.md（agent runtime + builtin tools） | 只跑 schema 校验（step 4）即可 |
| 有 `tools/*.js` / `handler.js` / `hooks/*.js` | + L2 单元测试（vitest，mock store） |
| 有 `input.inject` / 多 runtime / event 链 | + L3 集成测试（`createTestHarness` + `MockLLM`） |
| 准备发布对外（社区插件） | + L4 真实 LLM E2E（`scripts/e2e-plugin-verify.ts`，**不要进 CI**） |

测试文件放 `plugins/<id>/tests/*.test.{js,ts}`，跑：

```bash
pnpm --filter @covel/plugin-<id> test
```

> 仓库外插件（`~/.covel/plugins/`）目前不强制测试，但写了同样能跑（在该插件目录下 `pnpm install vitest @covel/plugin-test-utils @covel/tools @covel/plugin-loader` 即可）。

### 6. 展示结果

给用户摘要：插件名 / runtime 列表（及各自优先级、触发方式、类型）/ 使用的工具 / UI 入口 / 玩家可调设置 / slot 依赖（如 `covel.image`）。问是否需要调整。

## Key Recipes

### 手动触发按钮 + 后台图像生成（最常用综合样例）

完整代码见 `references/example-plugins.md` 的 dashscope-image-gen 小节。关键点：

1. 多 runtime 结构，根目录只放 `package.json`。
2. Runtime A（agent, manual, sync）生成 prompt —— agent 在 **runtime output** 里返回 `events: [{topic: 'image.generate.requested', data: {prompt}}]`（frontmatter 不能声明事件，`outputConfigSchema` 是 strict 的，只允许 `schema`/`recordAs`）。
3. Runtime B（function, event, background）消费事件，`ctx.gateway.generateImage({ presetId: 'image', prompt, ... })`，结果通过 `pluginData: [{namespace:'images', key, value}]` 写到 `images` namespace。
4. UI spec：按钮 spec（`invokeRuntime`）+ 画廊 spec（`dataSource.namespace: 'images'`，用 `Image` 组件 + `$item` 绑定 `value/url`/`value/base64`）。
5. 玩家设置通过 `userSettings` 在 frontmatter 声明后，**前端表单自动注册**；服务端有三条注入通道可直接使用：function handler 收到 `ctx.userSettings`、agent `guard` 收到 `ctx.userSettings`、agent 系统 prompt 可用 `{{ userSettings.<key> }}` 模板变量（框架 `resolveUserSettings` 已合并 manifest 默认和玩家值）。按钮点击时也可通过 `ctx.manualPayload` 传一次性覆盖。
6. API key 用 slot：在 `llm.toml` 里配 `[covel.image]` section，插件通过 `presetId: 'image'` 自动路由，**不要**让插件读 `.env` / `process.env`。

### Plugin-data 注入到 prompt（避免工具调用回合）

agent runtime 想把本插件的状态塞进 system prompt，用 `input.inject` 的 `plugin-data` kind：

```yaml
input:
  inject:
    - kind: plugin-data
      namespace: entries
      as: "<existing-entries>"
      format: summary      # summary / ids-only / full
      maxEntries: 50
```

### 首轮门控

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
```

### 硬门控 upstream

```yaml
upstreamRequired: [narrator]   # 上游本 turn 非 success → 本 runtime 直接 skipped
```

### 多媒体 / 音频 / 视频（mimo-tts、dashscope-image-gen 范式）

任何"生成内容并要播放/展示"的插件流程：

1. **拿字节** — `ctx.gateway.resolveSlot({presetId, fallbackTag})` 取 `baseUrl/apiKey/model`，自己 `fetch` 拿到原始字节。短链 URL 用 `ctx.media.ingestUrl(url, {allowedMimes})`。
2. **存进 MediaStore** — `ref = await ctx.media.put(bytes, mime, meta)`。
3. **发 plugin-data + assets**：
   ```js
   return {
     pluginData: [{ namespace: 'tracks'|'images'|..., key: turnId, value: { ref, status:'done', ... } }],
     assets:     [{ ref, modality: 'audio'|'image'|'video'|'file', meta: { ... } }],
   };
   ```
4. **UI** — spec 里用 `Media`（自动按 mime 选控件）或 `Image`。

完整 ctx + 返回字段契约见 [`runtime-context.md`](references/runtime-context.md) §Handler 返回值。组件 props + binding 语法见 [`ui-components-quickref.md`](references/ui-components-quickref.md)。已知限制（autoPlay / 流式 / 速度按钮）也都在那里。

### Provider 用「自定义 header / 怪 wire」时

如果 provider 不是 `Authorization: Bearer …`（如 MiMo TTS 用 `api-key`，DashScope wan2.x 用 async submit + poll），**插件自管 wire**：用 `ctx.gateway.resolveSlot()` 取 `baseUrl/apiKey/model`，自己 `fetch`，把共享代码放 `<plugin>/lib/*.js`（不在 `runtimes/*` 下避免被当 runtime 扫到，handler 用相对路径 `../../lib/...` import）。

完整决策树 + 鉴权头差异表 + body 形态差异表 + 响应解析差异表 + 失败处理范式见 [`provider-quirks.md`](references/provider-quirks.md)。

## References（按需阅读）

**SDK 级合约（独立于源码）**——任何场景都能查：

- [`runtime-context.md`](references/runtime-context.md) — function handler `ctx` 全字段 + 返回值 normalizeOutput 契约 + cheatsheet
- [`llm-toml-slots.md`](references/llm-toml-slots.md) — 用户 slot 配置全字段 + 枚举值表 + 4 个常见踩雷点 + apiKey 解析规则 + SSRF 真相
- [`ui-components-quickref.md`](references/ui-components-quickref.md) — 36 个 json-render 组件 + 全 props + 5 个 `on.click.action` + binding cheatsheet + 完整 spec 样例
- [`provider-quirks.md`](references/provider-quirks.md) — 自管 wire 决策树 + 鉴权/body/响应差异表 + 排查流程

**Plugin 包级（PLUGIN.md / 工具 / 测试）**：

- [`plugin-schema.md`](references/plugin-schema.md) — `PLUGIN.md` frontmatter 全字段（strict）
- [`example-plugins.md`](references/example-plugins.md) — 现有插件 + 多 runtime / 手动 / 后台 / 图像 / 音频综合样例
- [`tool-factory.md`](references/tool-factory.md) — 自定义本地工具的工厂模式
- [`plugin-testing.md`](references/plugin-testing.md) — 4 层测试指引（schema / 单元 / harness / 真实 LLM）

**何时读哪份**：

| 场景 | 必读 |
|------|------|
| 写任何 function runtime handler | runtime-context |
| 写自管 wire（图像/音频/视频/embedding/非 Bearer 鉴权） | provider-quirks + runtime-context |
| 写 UI spec（panel / button / form / gallery） | ui-components-quickref |
| 用户报"slot 配置错"或要写 README 配置块 | llm-toml-slots |
| 写 `PLUGIN.md` frontmatter | plugin-schema |
| 写 `tools/*.js` 自定义工具 | tool-factory |
| 写完后想加测试 | plugin-testing |
