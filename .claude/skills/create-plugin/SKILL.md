---
name: create-plugin
description: 创建 Covel 插件。通过对话了解需求，直接生成 PLUGIN.md + package.json 写入 plugins/ 目录并验证。当用户想创建新插件、新游戏机制、新功能模块、或者说"帮我做一个 XX 系统"时触发。
user_invocable: true
---

# 创建 Covel 插件

根据用户需求，直接生成完整的插件文件并写入目标目录（默认 `plugins/`，用户指定第三方插件时写 `~/.covel/plugins/`）。

## 核心事实（不用读框架代码）

- **插件 = 一组 Runtime**。每个 runtime 是一个独立调度单元，有自己的 `PLUGIN.md`（frontmatter + Markdown）。
  - 单 runtime：根目录只放一个 `PLUGIN.md`。
  - 多 runtime：根目录无 `PLUGIN.md`，把每个 runtime 放到 `runtimes/<sub>/PLUGIN.md`。框架自动扫描。
- **Runtime 类型**
  - `agent`（默认）：LLM 驱动，正文就是 system prompt。支持 `model` slot。
  - `function`：纯 JS handler，不跑 LLM，由 `handler: ./handler.js` 指向入口。可访问 `ctx.gateway` 调 LLM/图像。
- **触发**：`auto`（每轮）/ `manual`（仅 `POST /plugin-rpc`）/ `scheduled` / `event` / `conditional` / `error-retry`。
- **手动触发按钮**：UI JSON 里设 `on.click.action: "invokeRuntime"` + `params.runtimeId`，框架默认 handler 会自动 POST `/plugin-rpc`，插件**不需要**写 React 代码。
- **同步 / 后台执行**（仅手动触发）：`execution: sync`（默认，阻塞 turn）/ `background`（202 + `jobId`，框架在 `_jobs/<jobId>` 写状态，前端通过 `plugin-data.changed` SSE 感知）。
  - 插件**禁止**主动写 `_jobs/*`，框架会覆盖。
- **事件链**：agent runtime 在返回里带 `output.events: [{topic, data}]`，下游 `trigger: {type: event, topic}` runtime 在同 turn 被拉起。
- **存储**：runtime 返回里带 `pluginData: [{namespace, key, value}, ...]`，框架自动转成 `plugin.data` / `plugin.data.batch` Proposal，写到 `plugin_data` 表 `(sessionId, pluginId, namespace, key)`。namespace 以 `_` 开头（如 `_jobs`）是框架保留。
- **UI**：`ui: { right | message | left: [./ui/xxx.json] }` 指向 json-render spec。`dataSource.namespace` 让 spec 自动从本插件的 plugin-data 读数据。

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
├── PLUGIN.md                         # 单 runtime 必须
├── runtimes/<sub>/PLUGIN.md          # 多 runtime:替代根 PLUGIN.md
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
upstreamRequired: [core-narrator]   # 上游本 turn 非 success → 本 runtime 直接 skipped
```

## References

- `references/plugin-schema.md` — 全量 frontmatter schema（strict）
- `references/example-plugins.md` — 现有插件 + 多 runtime / 手动 / 后台 / 图像 综合样例
- `references/tool-factory.md` — 自定义本地工具的工厂模式
- `references/plugin-testing.md` — 4 层测试指引（schema / 单元 / harness 集成 / 真实 LLM E2E），含 vitest + MockLLM + createTestHarness 模板

**当用户需求超过基础 auto-trigger agent 插件（例如手动按钮、多 runtime、后台任务、function runtime、图像生成、复杂 UI）时，一定要先读 `references/example-plugins.md` 的 dashscope-image-gen 小节再动手。**

**当插件含本地 JS（`tools/*.js` / `handler.js` / `hooks/*.js`）或多 runtime 协作时，写完后必读 `references/plugin-testing.md`，按决策树补一层测试。**
