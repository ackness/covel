# Plugin RPC Runtime Pipeline

**Branch**: `feat/plugin-rpc-runtime-pipeline`
**Driver**: 让第三方插件（`~/.covel/plugins/dashscope-image-gen`）能用下列交互：手动按钮触发 → LLM 生成图像 prompt → 后台调用 DashScope 文生图 → 完成后 SSE 回写 UI。

## 能力矩阵

| # | 能力 | 当前状态 | 改造后 |
|---|------|---------|--------|
| 1 | 外部插件目录加载 | ✅ 已完整 | 复用 |
| 2 | UI 插槽 (right/message/left) | ✅ 已完整 | 复用 |
| 3 | Action-level plugin-rpc | ✅ 已完整 | 复用 |
| 4 | SSE `plugin-data.changed` | ✅ 已完整 | 复用 |
| 5 | 插件 config 字段 | ✅ 已完整 | 复用 |
| 6 | 图像生成 (gateway.generateImage) | ✅ 已完整 | 复用 |
| 7 | Runtime-level manual trigger | ❌ 返回 501 | **新增** |
| 8 | 链式 runtime (P600 → P610) | ❌ 没有 follow-up | **新增**（事件驱动） |
| 9 | Async / background runtime | ❌ 只同步 | **新增**（`execution: 'background'`） |
| 10 | 插件独立 provider | ⚠️ 部分 | 复用 `llm.toml` slot (选 A) |

## 设计决策

1. **Manual trigger 通过事件驱动的 one-shot turn 实现**
   - `POST /api/sessions/:id/plugin-rpc { pluginId, runtimeId, payload }` 构造一个只包含"目标 runtime + 其事件后继"的执行子集
   - `TurnInput` 新增 `manualTrigger: { runtimeId, payload }`
   - `TriggerContext.isManualTrigger` 只对 `manualTrigger.runtimeId` 匹配的 runtime 为 true

2. **链式执行：事件 proposal + 组间 flush**
   - P600 走完输出 `event.emit` proposal → turn-executor 在 priority group 结束时把事件合并进 `pendingEventTopics`
   - P610 声明 `trigger.type: event, topic: ...` 自然被后续 group 触发
   - 避免新增 `follows` 字段隐式耦合

3. **Background 模式：`setImmediate` + 长生命周期依赖**
   - `manifest.execution: 'sync' | 'background'`（默认 sync）
   - background runtime 被触发时：handler 立即写 `_jobs/{jobId} = { status: 'pending' }` 到 plugin-data → 返回 `202 + { jobId, pending: true }` → `setImmediate` 里继续跑
   - `store`、`eventBus`、`turnExecutorDeps` 在 bootstrap closure 里持有，不依赖 Hono request context
   - 完成后更新 `_jobs/{jobId} = { status: 'done', result }` 触发 SSE

4. **Provider 配置：复用 llm.toml slot**
   - 插件声明 `model: "covel.dashscope-image"`
   - 玩家在 `llm.toml` 写 `[covel.dashscope-image]` 段（desktop 自动加载 `~/.covel/llm.toml`）
   - API key 走 `X-Provider-Keys` header（已有机制）

## 改造清单

### P1 - 框架核心

| 文件 | 变更 |
|------|------|
| `packages/shared/src/types/execution.ts` | `TurnInput` 新增 `manualTrigger?: { runtimeId, payload }` |
| `packages/shared/src/types/plugin.ts` | `RuntimeManifest` 新增 `execution?: 'sync' \| 'background'` |
| `packages/shared/src/manifest/runtime-manifest-schema.ts` | Zod schema 追加 execution 枚举 |
| `packages/runtime/src/types.ts` | `TriggerContext` 保留 `isManualTrigger`，`FunctionHandlerContext` / `AgentContext` 新增 `manualPayload?` |
| `packages/runtime/src/turn-executor.ts` | ① `isManualTrigger` 条件判断<br>② 组间 flush pending event topics<br>③ 单 runtime 模式下跳过 auto 触发筛选 |
| `packages/runtime/src/trigger.ts` | 现有 `event` 逻辑已支持，无需改 |
| `packages/store/src/contract/store-contract.ts` | 新增 `listPendingEvents` / `clearPendingEvents` 契约测试 |
| `packages/store/src/types.ts` | `DataStore` 接口新增可选方法 |
| `packages/store/src/{memory,sqlite,postgres,indexeddb}/*-store.ts` | 四套实现 |
| `apps/server/src/routes/api/plugin-rpc.ts` | 实现 `runtimeId` 分支，sync + background 双路 |
| `apps/server/src/routes/api/bootstrap.ts` | 把 `executeTurn`、`activeRuntimesResolver` 挂到 Hono context |

### P2 - 前端 + 插件

| 文件 | 变更 |
|------|------|
| `apps/web/src/services/api.ts` | `postPluginRpc` 泛化返回 `{ status, result?, jobId?, pending? }` |
| `apps/web/src/stores/session-store.tsx` | plugin-data `_jobs` 命名空间消费，暴露 `pluginJobs` 选择器 |
| `apps/web/src/components/session/right-panel.tsx` | 识别 json-render 的 `status-indicator` 组件（如需新增） |
| `plugins/` 或 `~/.covel/plugins/dashscope-image-gen/` | 新建插件（PLUGIN.md + package.json + tools/） |

### P3 - 文档 + Skill

| 文件 | 变更 |
|------|------|
| `docs/reference/api.md` | plugin-rpc `runtimeId` 分支 + 202 + jobId 语义 |
| `docs/reference/plugins.md` | `execution` 字段说明 |
| `docs/reference/protocol.md` | `_jobs` namespace + plugin-data.changed 消费指南 |
| `docs/guide/plugin-authoring.md` | 手动触发 + 异步 + 自定义 slot 完整教程 |
| `.claude/skills/create-plugin/references/plugin-schema.md` | 追加 execution、事件触发、自定义 slot 段落 |
| `.claude/skills/create-plugin/references/example-plugins.md` | 追加"手动+异步双 runtime"样例（即本插件的简化版） |

## 目标插件设计：dashscope-image-gen

**位置**: `~/.covel/plugins/dashscope-image-gen/`（符号链接或直接放）

### Runtime 1: prompt-generator (P600)

```yaml
name: dashscope-image-gen/prompt-generator
priority: 600
runtimeType: agent
model: default   # 复用主文本模型
trigger:
  type: manual
input:
  # 运行时自动获得 {{ turn.recentNarrative }} 等上下文
output:
  recordAs: image-prompt
tools:
  builtin:
    - plugin-data-set
```

读插件 config 中的 `promptMode`（`text` / `image-json`），两条分支的 system prompt：
- `text` 模式：产出 ~80-150 词的密集场景描述（subject + scene + style + lighting + camera + quality tokens）
- `image-json` 模式：产出结构化 JSON `{ subject, setting, composition, lighting, style, camera, mood, negative }`

Runtime 输出后：
1. 调用 `plugin-data-set` 把 prompt 存进 `_current/prompt`
2. emit event proposal `image.generate.requested`

### Runtime 2: image-generator (P610)

```yaml
name: dashscope-image-gen/image-generator
priority: 610
runtimeType: function
handler: ./runtimes/image-generator.js
model: covel.dashscope-image
execution: background   # 默认 background
trigger:
  type: event
  topic: image.generate.requested
```

Function handler:
1. 从 plugin-data 读 `_current/prompt`
2. 调用 `context.generateImage(prompt, { model, size })`（gateway 的方法，框架已实现）
3. 产出 `record.upsert` proposal 存图片（URL 或 base64）
4. 更新 `_jobs/{jobId}` status

### 插件 config

```yaml
config:
  promptMode:
    type: enum
    options: [text, image-json]
    default: text
    label: 提示词生成模式
  executionMode:
    type: enum
    options: [sync, background]
    default: background
    label: 图像生成执行模式（覆盖 manifest.execution）
  imageModel:
    type: string
    default: wan2.2-t2i-plus
    label: 图像模型
  imageSize:
    type: string
    default: 1024*1024
```

说明：DashScope 官方文生图模型列表以当前 API 为准（wan2.2-t2i-plus 为目前稳定可用；wan2.7-image-pro 尚未查证）。先以 plugin config 默认值占位，最终值由实际联调确定。

### UI

```yaml
ui:
  right:
    - id: image-gallery
      spec: ./ui/gallery.json
  message:
    - id: generate-btn
      spec: ./ui/generate-button.json
```

- `generate-button.json`: 一个 button（json-render `button` 组件），action = `triggerRuntime(runtimeId: dashscope-image-gen/prompt-generator)`；button 在 `_jobs.*.status === 'pending'` 时进入 loading 态
- `gallery.json`: 列表展示 `pluginData['dashscope-image-gen'].gallery.*`

## 测试策略

| 层级 | 新增 |
|------|------|
| 单元 | `turn-executor.test.ts`: manual trigger 只跑目标 runtime；pending events 在组间 flush |
| 契约 | `store-contract.ts`: listPendingEvents/clearPendingEvents 所有后端一致 |
| 集成 | `plugin-rpc.test.ts`: sync 分支返回 result；background 分支返回 202 + jobId |
| E2E | `scripts/e2e-plugin-verify.ts` 新增 dashscope-image-gen case（mock gateway.generateImage） |

## 里程碑

1. **M1 - Schema/类型**: `TurnInput.manualTrigger` + `RuntimeManifest.execution` + store 接口
2. **M2 - Runtime**: turn-executor 两条改造 + store 四端实现
3. **M3 - Server**: plugin-rpc runtimeId 分支 (sync) + bootstrap 依赖挂载
4. **M4 - Server async**: plugin-rpc background 分支 + _jobs 协议
5. **M5 - 前端**: postPluginRpc + session-store + UI
6. **M6 - 插件**: dashscope-image-gen 完整实现
7. **M7 - 文档 + skill**: 框架文档 + skill 样例更新
8. **M8 - 测试**: 单元 + 契约 + 集成 + E2E
