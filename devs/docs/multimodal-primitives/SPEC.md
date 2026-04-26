# 多模态原语统一架构 — 设计 Spec

**状态:** Draft（讨论稿，未决）
**日期:** 2026-04-26
**作者:** ackness（with Claude）
**范围:** 跨多模态（图像 / 语音 / 视频 / 文件 / 地图 / NPC 头像 / 交互对话等）的内核原语、消息模型、Hook 语义、工具协议
**范围外:** 具体 provider 接入细节、UI 视觉设计、插件进程隔离（sidecar / worker）

> **状态（2026-04-26 第三版，含 Codex 评审修订）**
>
> **第二版基础**：commit `d9caf04` `refactor(ai-provider): plugins own image-generation wire end-to-end` 已落地。框架移除 `gateway.generateImage` / `ImageApiFormat` enum / `generateImage` adapter method（-385 行），改为提供三个原语：`gateway.resolveSlot` / `ctx.utils.validateBaseUrl` / `ctx.utils.fetchWithRetry`。两个图像插件已完成 wire 插件化（dashscope 自包 wan2.x 异步轮询，openai 用 Vercel AI SDK v6）。这个变更**坐实了本 spec 的核心主张——"框架提供原语，插件拥有 wire"**。
>
> **第三版修订重点**（详见 § 0.0）：`asset.generate` 端到端接入 kernel 被拆为 P0-b；全局 Proposal codec 改为 `asset.generate` 局部 helper；MediaRef 权限、snapshot/fork、远程 ingest 被纳入 P0；`PreStateCommit` 采用 `sequential`；第一版后端范围收敛为 Memory + SQLite/local-fs。
>
> Phase 计划已重排为 **P0-a/b/c/d + P1 + P2 + P3** 共 7 阶段，总计 9-13 周（之前估的 5-7 周低估了端到端接入工作量）。详见 § 6。

---

## 0.0 当前评审结论（2026-04-26）

**总体判断**：方向合理，P0 应聚焦 `MediaRef + MediaStore + ctx.media` 与真实 `asset.generate` 流。这能补齐 `resolveSlot / validateBaseUrl / fetchWithRetry` 之后的存储原语缺口，也能直接解决两个图像插件把大对象写进 `plugin_data` 的问题。

**当前框架对齐度**

- `ctx.media` 注入方式贴合现有 `FunctionHandlerContext`：`ctx.gateway`、`ctx.utils`、`ctx.pluginData` 已经是同一风格，落点是 `packages/plugin-loader/src/types.ts`、`packages/runtime/src/plugin-handler-helpers.ts`、`packages/runtime/src/turn-executor.ts`。
- `MediaStore` 适合沿用 store 层 contract-test 模式：`packages/store/src/contract/*` 已有 store/vector 合约，新增 `media-store-contract.ts` 即可复用测试结构。
- 前端当前是 json-render catalog，`Image` 组件已支持 `src/base64`；`Media` 组件或 `Image` 的 `{ ref }` 支持都贴合现有 UI 模型。
- commit `d9caf04` 的方向已和当前代码一致：高层 `generateImage` adapter 已移除，插件通过 `ctx.gateway.resolveSlot()` 自管 wire，框架提供 slot / SSRF / retry 原语。

**推荐推进顺序**

1. P0-a：`MediaRef`、`MediaStore` 最小版、`ctx.media.put/get/resolveUrl/ingestUrl`、`/api/media/:id`、`Image/Media` 组件支持 ref。
2. P0-b：`asset.generate` 接入 kernel：normalizer 接收 `output.assets[]`，commit handler 落 trace/SSE，web 按 `modality` 渲染。
3. P0-c：迁移两个图像插件：handler 写 `ctx.media.put/ingestUrl`，`plugin_data.images` 保留索引记录，UI 读 `ref`。
4. P0-d：补迁移脚本和 snapshot/fork 媒体引用，完成端到端回归。
5. P1：Hook 语义、`asset.generate` 局部 view/LLM helper、ToolClient 统一。
6. P2：recursiveCall、ui.render parts、PG/S3/IDB/Tauri 媒体后端、通用 gallery preset。

## 0. 为什么写这份文档

- 当前框架已有 `OutputModality` capability、`UIRenderInstruction[]`、`ProposalType.asset.generate` 等多模态雏形，但部分能力停留在类型声明层，kernel 路径需要补齐。
- 即将增加语音、地图、NPC 头像、交互对话等模态，**现在收敛可以避免每个新模态重复"base64 入消息 / UI 不一致 / Hook 不可组合 / 重试缓存各做一份"等同样的问题**。
- 调研了 LobeChat / LibreChat / OpenWebUI / Vercel AI SDK / Big-AGI / ComfyUI / Cherry Studio 共 7 个开源项目的设计取舍，对应的成功设计与失败教训对本 spec 都有参考。
- 文档用于评估改动必要性、范围和实施节奏，供后续排期决策。

---

## 0.1 已确立的指导原则（来自 commit d9caf04）

`d9caf04` 提交说明里有一句关键话：

> "Image wire formats don't share enough shape to make a centralized adapter pay off (unlike text protocols)."

这条决定把项目过去含糊的"框架图像 wire 边界"问题钉死了：

| 类别 | 框架抽象价值 | 为什么 |
|---|---|---|
| **Text LLM wire**（OpenAI Chat / Anthropic Messages / Responses） | 高 | 三家协议虽不同但形状收敛（messages / tool_calls / streaming），框架级 adapter 受益面大 |
| **Image generation wire**（DashScope async / OpenAI sync / Replicate webhook / fal queue） | 低 | 形状太分散：异步 vs 同步、submit-poll vs 直返、URL vs base64 vs uint8Array、参数命名各异；框架抽象会压缩每个 provider 的能力 |
| **Storage**（PNG / WAV bytes 落盘） | 高 | 与 wire 无关，PNG 就是 PNG，content-addressable + dedup + 多端策略全是 transport-level 关注点 |
| **认证 / 网络**（API key、SSRF、retry / backoff、timeout） | 高 | 安全敏感、跨 provider 同质、必须中心化以保证一致性 |
| **UI**（gallery / regenerate button / status badge） | 高 | 多个图像插件天然需要相同的展示语义 |

本 spec 据此校准：

- **L0 Transport**（强制）：存储、认证、SSRF、retry、trace、SSE → 框架管
- **L1 Media 原语**（强制）：`MediaRef` 类型、`MediaStore` 接口、`resolveSlot`、`validateBaseUrl`、`fetchWithRetry` → 框架管，wire 抽象留给插件
- **L1 Media wire**：HTTP 调用、SDK 选择、provider quirks → **插件管**
- **L2 Experience**（默认实现 + 可替换）：UI 组件、envelope schema → 框架提供默认，插件可以替换
- **L3 Domain**：prompt 工程、玩法规则 → 插件完全自由

下文所有 P0/P1 改动都遵循这个边界。

---

## 1. 现状盘点

### 1.1 已有的多模态机制

| 位置 | 现状 | 评价 |
|---|---|---|
| `ProposalType.asset.generate` | shared type 已声明，kernel normalizer / commit handler 待接入 | P0-b 需要补 normalizer、commit、trace/SSE、web renderer |
| `ProposalType.ui.render` + `UIRenderInstruction[]` | shared type 已声明，当前 UI 主路径主要走 `interaction.request` / `ui-spec` block | P2 再做 part status 与细粒度更新 |
| `OutputKind = 'story' \| 'plugin' \| 'system'` | 输出去向分类 | ✅ 已生效 |
| `RuntimeManifest.capabilities: string[]` | 能力发现机制 | ✅ 用法已规范化（`narrative` / `world-data-provider` / `image-generation`） |
| AI provider `capability/` 模块 | 模型能力检测（vision / function call / reasoning） | ⚠️ 只覆盖 LLM，不覆盖图像 / 语音 |
| `TurnMessage.content: string` + `ui?: UIRenderInstruction[]` | 单一 string + 可选 UI 指令 | ⚠️ 流式 + 多 part 混排时表达不清 |
| `RuntimeOutput.results[].structured` | 插件结构化输出 | ✅ 但前端按 structured 渲染时缺统一约定 |
| `Hook`（8 个事件）+ `HookResult<P>` | 生命周期钩子 | ⚠️ 无语义分类，多插件叠加行为靠口口相传 |
| `tools/builtin/` + `local tools` | 两套代码路径 | ⚠️ 未来接 MCP 时要再写第三套 |

### 1.2 实际痛点（来自现有插件）

`~/.covel/plugins/dashscope-image-gen`、`~/.covel/plugins/openai-image-gen` 是当前两个图像插件。它们各自实现了：

- 自己的图片存储路径策略（绕过框架）
- 自己的 UI 组件（`gallery.json` / `jobs.json` / `generate-button.json` 各画一份）
- 自己的重试 / 超时 / 缓存策略
- 自己的 base64 / URL 处理逻辑

如果再加 TTS、地图 tile、NPC 头像、对话气泡等模态，**每个新插件都会重复一次这些工作**。

### 1.3 Proposal 类型现状

| 层级 | 类型 | 当前状态 |
|---|---|---|
| Kernel 已接入 | `narrative.append` / `interaction.request` / `state.patch` / `event.emit` / `plugin.data` / `plugin.data.batch` / `working_memory.set` / `lorebook.upsert` | `session-kernel.ts` 已有 normalizer 或 commit handler |
| Shared type 已声明 | `record.upsert` / `ui.render` / `asset.generate` / `narrative.template` | 类型层存在；kernel 路径需要逐项接入 |
| P0 目标 | `asset.generate` | 先打通多模态 envelope，payload 收紧为 `{ ref: MediaRef, modality, meta }` |

### 1.4 现有 Hook 类型清单

```
TurnStart    PreRuntime   PostRuntime
PreToolUse   PostToolUse
PreStateCommit  PostStateCommit
TurnStop
```

8 个事件，所有都返回 `HookResult<P> = continue | continue+replace | abort`，**没有语义类别**——多个插件叠加时是按注册顺序合并 replace，但这只在 `pipeline.ts` 代码里有，没在文档/类型里。

### 1.5 现有插件 Hook 使用盘点（2026-04-26 实测）

`grep -rn "^hooks:" plugins/ ~/.covel/plugins/` 三次全部空输出。结论：

> **当前 14 个 runtime（10 个 `core-*` + 4 个用户态）中，0 个声明了 hook。**

调度完全依赖：
- 优先级 band（0-99 pregame、400-1000 main loop）
- `upstreamRequired` 声明
- `trigger.type: event` 事件触发（图像插件用）
- `guard.js` 决策（core-char-creator 用）

**这让 § 5.3 Hook 语义改动成为 P1 的低风险项**——当前没有现存插件代码依赖旧 hook 行为。详见附录 C。

---

## 2. 设计目标

1. **L0 Transport 强约束**：插件调用统一经过框架的 envelope / 存储 / key 管理 / SSRF 防护（安全红线）。
2. **L1 Media 双轨**：framework 提供**原语**（MediaStore、resolveSlot、validateBaseUrl、fetchWithRetry），插件**拥有 wire**（HTTP 调用、SDK 选择、provider quirks）。这是 commit `d9caf04` 已确立的方向，本 spec 顺势补齐 MediaStore 作为最后一个缺位的原语。
3. **L2 Experience 给最小契约**：单一 `asset.generate` envelope（P0-b 接入）+ `modality` 标签 + UI 组件按 tag 路由。新模态沿用同一 envelope。
4. **L3 Domain 完全自由**：provider 接入、提示词工程、玩法规则，框架不干涉。
5. **零回归**：现有 10 个 `core-*` 插件 + 4 个用户态图像 runtime 保持可运行，必须有迁移期 + 兼容 shim。

## 3. 边界

- 插件能力保持为 runtime / context inject / hook / proposal envelope / UI slot 的组合；MCP 作为工具协议子集参考。
- Covel 保持 UI 一致性职责；SDK-only 模式只作为 provider 接入参考。
- 插件进程隔离（sidecar / worker）放入单独 spec。
- `RuntimeOutput` / `TurnMessage` 持久化层保留现有结构，只做最小增量。

---

## 4. 总体架构：四层模型（已按 d9caf04 校准）

```
┌─────────────────────────────────────────────────────────┐
│ L3 Domain Logic                                         │  插件完全自由
│  prompt 工程 / 玩法规则 / provider 接入                 │  框架不干涉
├─────────────────────────────────────────────────────────┤
│ L2 Experience                                           │  envelope schema 默认实现
│  asset.generate envelope / UI 组件库 / 重生成动作       │  插件可替换 UI
├─────────────────────────────────────────────────────────┤
│ L1 Media — wire (插件管) ↔ 原语 (框架管)               │
│  ┌──────────────────────┬────────────────────────────┐ │
│  │ Plugin owns wire     │ Framework provides utils   │ │
│  │ HTTP / SDK / 解析     │ resolveSlot / SSRF / retry │ │
│  └──────────────────────┴────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ L0 Transport                                            │  框架强制
│  MediaStore / ToolClient / Hook 引擎                    │  统一入口
│  trace / SSE / key 管理 / 内容寻址存储                  │
└─────────────────────────────────────────────────────────┘
```

层与层之间通过**类型契约**对接，不靠"约定俗成"。每一层的"强制 vs 可选"由 plugin-loader 在加载时校验。

**L1 Media 是这一版最关键的层**：框架提供做事所需的原语，插件用这些原语自己做事。`d9caf04` 之后这一层的边界已经清晰：

- 插件接 OpenAI、DashScope、Replicate、fal、本地 SD WebUI 都用同一套原语
- 想用 Vercel AI SDK 还是 raw fetch 都行
- 想做异步轮询还是同步直返都行
- 所有网络、密钥、文件写入都经过 SSRF 检查、key 管理和 MediaStore——这些是 L0 强制约束

---

## 5. 详细设计

§ 5 按主题组织，真实落地顺序以 § 6 的 P0-a/b/c/d + P1/P2/P3 为准。

### 5.1 P0-a: `MediaRef` + 内容寻址存储

#### 当前问题

- `asset.generate` proposal 的 payload 没有约束，插件可以塞任意结构（包括巨型 base64）
- 图像/音频文件没有统一存储抽象——dashscope 和 openai 两个插件各自管文件
- `trace_events` 表会被大对象撑爆（PG TOAST 之后查询性能崩溃）
- 多端（web / electron / tauri）同步时网络开销爆炸
- 同一张 NPC 头像在 200 个 turn 里重复出现，按 base64 算等于存 200 遍

#### 提议方案

**(a)** 在 `@covel/shared/types/media.ts` 新增类型：

```typescript
export interface MediaRef {
  /** Stable id; SHA-256 of content (content-addressable). */
  readonly id: string;
  /** MIME type, e.g. 'image/png', 'audio/wav', 'video/mp4'. */
  readonly mime: string;
  /** Byte size; useful for budgeting / progress. */
  readonly size: number;
  /**
   * Optional pre-signed URL. If absent, resolve via MediaResolver.
   * Never trust this URL across sessions — content-addressable means
   * the id is the source of truth.
   */
  readonly url?: string;
  /** Free-form metadata: dimensions for images, duration for audio, etc. */
  readonly meta?: Readonly<Record<string, unknown>>;
}
```

**(b)** 在 `@covel/store` 增加 `MediaStore` 接口：

```typescript
export interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;  // signed/short-lived
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
}
```

后端路线：
- P0：`MemoryStore` → in-memory `Map<id, Uint8Array>`
- P0：`SqliteStore + local-fs` → `media_assets` 表存元数据 + `<covelHome>/media/{ab}/{cd}/<sha256>.bin`
- P2：`PgStore + S3`、`IdbStore`、Tauri command 适配

**(c)** `asset.generate` proposal 的 payload 收紧（见 § 5.7：保留单一 envelope，强制 `ref: MediaRef` + `modality: string`）。

**(d)** **方案 A（推荐）**：把 MediaStore 通过 `ctx.media` 直接注入 plugin runtime context（与已有的 `ctx.gateway` / `ctx.utils` / `ctx.pluginData` 并列）：

```typescript
// 与 d9caf04 引入的 ctx.utils 同款风格
interface FunctionHandlerContext {
  // ... existing
  readonly gateway: { resolveSlot(...): ResolvedSlotConfig | null };
  readonly utils: { validateBaseUrl(...): ...; fetchWithRetry(...): ...; };
  readonly pluginData: { set(...): ...; get(...): ...; ... };

  // NEW
  readonly media: {
    put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
    get(ref: MediaRef): Promise<Blob>;
    resolveUrl(ref: MediaRef): Promise<string>;
  };
}
```

**方案 B（备选）**：通过 `tools/builtin/` 增加 `media-put` / `media-get` 内置工具，插件通过 LLM tool-call 上传——但 function runtime 无 LLM 不适用，且增加一次序列化开销。

→ **建议方案 A**，与 commit `d9caf04` 风格一致（直接 ctx 注入而非中介层）。

**(e) `asset.generate` 端到端接入 kernel**（Codex 评审 #1 修正）

`ProposalType.asset.generate` 当前位于 shared type 层；`packages/runtime/src/session-kernel.ts` 的 `normalizeOutput()` 把 runtime 输出转成 Proposal 时，覆盖 narrative / interaction / state / event / plugin-data / working-memory / lorebook，`asset.generate` 路径和 commit handler 需要新增。

> **结论**：本 spec 把 `asset.generate` 端到端接入列为新增基础设施。

具体接入点：

```
runtime handler `output.assets[]`  →  normalizeOutput()  →  Proposal{ type: 'asset.generate' }
  →  PreStateCommit hook chain  →  commit handler 持久化  →  trace_events
  →  SessionEvent  →  SSE 推前端  →  按 modality 渲染
```

每一段都要新增代码。详见 § 6 Phase 0-b。

**(f) `ctx.media.ingestUrl(remoteUrl, opts)` 远程拉取 helper**（Codex 评审 #6 修正）

`ctx.utils.fetchWithRetry` 只覆盖 429/5xx 重试。把远程图片（如 DashScope OSS URL）拉进 MediaStore 时还需要：
- SSRF 校验（与 `validateBaseUrl` 同源策略）
- redirect 后**复验**目标 URL（防止 SSRF 绕过）
- `content-length` 上限保护（防止超大资源 OOM）
- MIME sniff（不信任 server 的 `content-type`）
- 下载总 timeout
- 最大字节数 cap（默认 50 MB，可覆盖）

应作为独立 helper：

```typescript
interface IngestUrlOptions {
  readonly maxBytes?: number;          // default 50 * 1024 * 1024
  readonly timeoutMs?: number;         // default 30_000
  readonly allowedMimes?: string[];    // sniff 后白名单校验
  readonly meta?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

interface MediaContext {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Blob>;
  resolveUrl(ref: MediaRef): Promise<string>;
  /** Fetch a remote URL into MediaStore in one safe call. */
  ingestUrl(url: string, opts?: IngestUrlOptions): Promise<MediaRef>;
}
```

DashScope handler 的迁移就用 `ctx.media.ingestUrl(first.url)`，一行替代手写的 `fetchWithRetry + arrayBuffer + put`，安全检查不漏。

**(g) MediaRef 权限边界 + 短期签名 token**（Codex 评审 #9 修正）

`MediaRef.id` 让任何持有 id 的客户端能拿到字节——**这是越权风险**。两个图像插件之间、不同 session 之间的资产必须隔离。

设计：

| 组件 | 行为 |
|---|---|
| `media_assets` 表 | 加 `owner_session_id` + `owner_plugin_id` 列；`media_refs` 表反向索引哪些 session 引用了哪些 ref（GC 用） |
| `GET /api/media/:id` | 必须带短期签名 token（如 HMAC-SHA256，5 分钟 TTL，含 `id + sessionId + exp`） |
| `MediaStore.resolveUrl(ref)` | 服务端按当前 session 颁发签名 URL，不返回裸 `/api/media/:id` |
| 跨 session 引用 | fork 时复制 `media_refs` 行（见 (h)），让 fork 出去的 session 也持有引用关系 |

**(h) Snapshot / fork 媒体可达性**（Codex 评审 #4 修正）

当前 `SnapshotPayload` 只带 `pluginData / messages / state / lorebook / suspensions`。如果 `pluginData` 里出现 `MediaRef`，fork 出去的 session 必须能解析这些 ref，否则会 404。

设计：

```typescript
interface SnapshotPayload {
  readonly pluginData: ...;
  readonly messages: ...;
  readonly state: ...;
  readonly lorebook: ...;
  readonly suspensions: ...;
  // NEW
  readonly mediaRefs: readonly MediaRef[];  // 此 snapshot 引用的所有 ref，fork 时必须持有
}
```

Fork session 时由 commit handler 扫描 snapshot 内容（深度遍历找 `{ id, mime, size }` 形状）填入 `mediaRefs`，并把 `media_refs` 表里这些行复制一份归到新 sessionId 名下。**不复制字节**——content-addressable 的好处就是字节只存一份，多个 session 共用。

**(i) Phase 1 后端缩减**（Codex 评审 #11 修正）

原方案"Memory + SQLite/local-fs + PG/S3 + IDB + Tauri 五种后端一次到位"过激。第一版只做：

- `MemoryStore` —— 测试 / 默认 dev 跑 in-memory Map
- `SqliteStore + local-fs` —— 桌面默认（`<covelHome>/media/{ab}/{cd}/<sha256>.bin`）
- `/api/media/:id` 服务端读
- 前端 `<Media src={ref}>` + IDB blob 缓存层

PG+S3 / IdbStore / Tauri 命令路径作为后续后端适配（Phase 2），按需补全。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/media.ts`（新） | `MediaRef` 类型 + Zod schema |
| `packages/store/src/media-store.ts`（新） | `MediaStore` 接口 + Memory + SQLite/local-fs 实现 |
| `packages/store/src/contract/media-store-contract.ts`（新） | 与现有 store / vector contract 同模式 |
| `packages/store/src/schema/*` | 新增 `media_assets`（owner / sha256 / size / mime / created_at）+ `media_refs`（sessionId → mediaId 反向索引） |
| `packages/plugin-loader/src/types.ts` | `FunctionHandlerContext` 加 `media: MediaContext` |
| `packages/runtime/src/plugin-handler-helpers.ts` | 注入 `ctx.media`（含 `put` / `get` / `resolveUrl` / `ingestUrl`） |
| `packages/runtime/src/turn-executor.ts` | wire `ctx.media` 到每个 runtime 调用 |
| `packages/runtime/src/session-kernel.ts` | `normalizeOutput()` 加 `asset.generate` 路径；commit handler 加 `asset.generate` 处理 |
| `apps/server/src/routes/api/media.ts`（新） | `GET /api/media/:id?token=...` 流式输出（含签名校验） |
| `apps/server/src/middleware/media-token.ts`（新） | HMAC-SHA256 签名 + 5 分钟 TTL |
| `apps/web/src/components/Media.tsx`（新） | 通用 `<Media src={ref}>` 组件 + IDB blob 缓存 |
| `packages/runtime/src/snapshot-payload-builder.ts` + `apps/server/src/routes/api/snapshots.ts` | `SnapshotPayload` 加 `mediaRefs`；fork 时复制 `media_refs` 行 |
| `packages/runtime/src/turn-emitter.ts` | trace 写入检测 base64 字段超过 8KB 自动转 ref（兜底） |

#### 旧代码可清理（具体迁移步骤）

两个图像插件目前都把字节当 base64 写进 `plugin-data.images`，可以**一次性迁到 MediaStore**。具体改动（每个 handler ~10 行）：

**openai-image-gen/runtimes/image-generator/handler.js**

```diff
  const result = await generateImage({
    model: provider.image(resolvedModel),
    prompt,
    n,
    size: imageSize,
    ...(Object.keys(providerOptions.openai).length > 0 ? { providerOptions } : {}),
  });

  const completedAt = new Date().toISOString();
  const images = Array.isArray(result.images) ? result.images : [];
  const first = images[0] ?? null;
  if (!first || (typeof first.base64 !== 'string' && !first.uint8Array)) {
    return failureRecord(...);
  }

- const base64 = typeof first.base64 === 'string' ? first.base64 : null;
- const mimeType = typeof first.mediaType === 'string' ? first.mediaType : 'image/png';
- const dataUrl = base64 ? `data:${mimeType};base64,${base64}` : null;
+ // Put each image into MediaStore, get back content-addressable refs.
+ const refs = await Promise.all(images.map(async (img) => {
+   const bytes = img.uint8Array ?? Buffer.from(img.base64, 'base64');
+   return ctx.media.put(bytes, img.mediaType ?? 'image/png', {
+     prompt, model: resolvedModel, n, imageSize, provider: slot.provider,
+   });
+ }));
+ const primaryRef = refs[0];

  const record = {
    ...baseRecord,
    status: 'done',
-   url: dataUrl,
-   base64,
-   mimeType,
-   all: images.map((img) => ({
-     base64: typeof img.base64 === 'string' ? img.base64 : null,
-     mimeType: typeof img.mediaType === 'string' ? img.mediaType : 'image/png',
-   })),
+   ref: primaryRef,
+   refs,  // gallery 用全部
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
```

**dashscope-image-gen/runtimes/image-generator/handler.js**

DashScope 比 openai 复杂一点——结果可能是远程 OSS URL（24 小时过期）也可能是 base64：

```diff
- // 旧：保留远程 URL + 可选 base64
- const record = {
-   ...
-   url: first?.url ?? null,
-   base64: first?.base64 ?? null,
-   expiresAt: first?.url ? new Date(Date.now() + DASHSCOPE_URL_TTL_MS).toISOString() : null,
- };
+ // 新：把 OSS URL 拉下来放进 MediaStore，永久持有，绕开 24h 过期
+ let ref;
+ if (first?.url) {
+   ref = await ctx.media.ingestUrl(first.url, {
+     allowedMimes: ['image/png', 'image/jpeg', 'image/webp'],
+     meta: { prompt, model: resolvedModel, provider: 'dashscope' },
+   });
+ } else if (first?.base64) {
+   ref = await ctx.media.put(Buffer.from(first.base64, 'base64'), 'image/png', {
+     prompt, model: resolvedModel, provider: 'dashscope',
+   });
+ } else {
+   return failureRecord(..., 'dashscope returned neither url nor base64');
+ }
+ const record = { ...baseRecord, status: 'done', ref, completedAt, durationMs };
```

**dashscope 这一改还顺便修复了"OSS URL 24 小时过期"的隐患**——之前画廊会在 24h 后变成断图，迁到 MediaStore 之后字节常驻本地/S3，永远可读。这是迁移的额外收益。

**现有数据迁移范围**（Codex 评审 #5 修正）：base64 不只在 `plugin_data` 一处。`pnpm migrate:media` 脚本必须扫描以下表：

| 表 | 字段 | base64 出现路径 |
|---|---|---|
| `plugin_data` | `value` JSONB | `value.base64` / `value.url`（dataURI）/ `value.dataUrl` |
| `runtime_results` | `output` JSONB | `output.url` / `output.base64`（部分图像 handler 旧版本） |
| `runtime_outputs` | `results[].structured` | 早期插件可能在 structured 里塞 base64 |
| `turn_results` | `runtimeResults[]` | 反序列化后再扫 `output` |
| `turn_messages` | `content` | 极少数情况下出现 inline `data:image/...;base64,` |
| `snapshots` | `payload.pluginData` 嵌套 | 走 plugin_data 同款扫描逻辑 |

脚本结构：按 sessionId 分批（避免大事务）、按表逐张扫、单条失败不阻断整体、每条迁移完写一行 `legacy_inline_media`（原表名 + 主键 + 旧字段哈希 + 新 ref id），60 天保留兜底回滚。

#### 清理后的后果

- 旧 session 存档里直接 inline 的 base64 图片需要数据迁移（`MediaStore.put` 一遍）—— 提供 `pnpm migrate:media` 脚本
- 已发布插件需要按收紧后的 `asset.generate` schema 改写（`{ ref: MediaRef, modality, meta }`）——提供 codemod
- **无法回滚的部分**：迁移完后 PG/SQLite 的 `messages` 表里 base64 字段消失，回滚到旧版会出现"图片显示不出来"；建议保留 `legacy_inline_media` 影子表 60 天

#### 这条改动 unlocks 什么

1. **同图 dedup**：200 turn 重复出现的"酒馆老板"头像只存一次（按 SHA-256 自然 dedup）
2. **trace 系统不爆炸**：trace_events 只记 ref，可以无损保留所有历史
3. **多端缓存策略统一**：web → IDB blob、electron → 本地 fs、生产 → S3，前端只看到 `MediaRef`
4. **插件可专注创意**：插件作者不需要懂存储后端、不需要写 LRU、不需要管多端差异
5. **图像索引功能自然成立**：玩家"看一下我以前路过的山洞图"——按 ref 反查所有引用过它的 turn

---

### 5.2 `asset.generate` 局部 view / LLM helpers（按 Codex #3 收敛）

> **设计修订（Codex 评审 #3）**：原方案计划给所有 ProposalType 注册全局 `Record / View / LLM` 三层 codec。现有系统已经有 4 层：`RuntimeOutputRecord` / `TurnMessageRecord` / `Proposal` / `SessionEvent`，LLM context 主要从 `turn_messages` 和 prompt assembler 走。再加入一套全局 codec 注册表会让心智负担陡增。
>
> **当前方案：先为 `asset.generate` 一种类型做局部 `toView` / `toLLM` 函数**，跑通后再评估统一 codec 的价值。其他 ProposalType 沿用现有路径。

#### 当前问题

只针对 `asset.generate` 这一类：
- 持久化到 `runtime_results` 时存 `MediaRef`（紧凑）
- SSE 推前端时需要带 resolved URL（短期签名）+ UI 状态
- 转给下一轮 LLM 时需要按 provider 编码（OpenAI `image_url` / Anthropic `image` source / Gemini `inlineData`）

这三种形态当前没有任何转换层，全靠插件 + 前端 + prompt-delta 各自手写。

#### 提议方案（局部）

只为 `asset.generate` 写两个函数 + 一个注册点：

```typescript
// packages/shared/src/proposals/asset-generate.ts
import type { Proposal, MediaRef } from '../types/...';

interface AssetGenerateView {
  readonly ref: MediaRef;
  readonly modality: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly resolvedUrl: string;       // 短期签名 URL，5 分钟 TTL
  readonly status: 'pending' | 'committed' | 'error';
}

export function assetGenerateToView(
  proposal: Proposal,
  ctx: { mediaResolver: MediaResolver; sessionId: string },
): AssetGenerateView { ... }

export function assetGenerateToLLM(
  proposal: Proposal,
  provider: 'openai' | 'anthropic' | 'gemini',
  ctx: { mediaResolver: MediaResolver },
): ProviderImageContent { ... }
```

> ⚠️ **依赖警告（Codex 评审 #10）**：当前 `@covel/ai-provider` 的 `TextMessage.content` 仍是 `string | null`，OpenAI / Anthropic adapter 只发纯文本。`assetGenerateToLLM()` 真正生效之前，必须先在 ai-provider 设计 content parts（`TextPart | ImagePart | ToolCallPart` 联合）。P0-a/P0-b 可先落地 `assetGenerateToView()`，LLM 多模态消费放到 P1。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/shared/src/proposals/asset-generate.ts`（新） | `assetGenerateToView` / `assetGenerateToLLM` |
| `packages/runtime/src/session-kernel.ts` / `packages/runtime/src/turn-emitter.ts` | commit / trace / SSE 侧对 `asset.generate` 调 `assetGenerateToView` |
| `packages/runtime/src/prompt-delta.ts` | 转 LLM 时对 `asset.generate` 调 `assetGenerateToLLM`（先打 stub，等 ai-provider content parts 落地后才实际生效） |
| `apps/web/src/stores/session-store.tsx` + `apps/web/src/components/asset-render/` | 接收 `AssetGenerateView`，按 `modality` 路由组件 |

#### 延后项

- 其他 ProposalType 继续使用现有 commit / event 路径，等第二、第三种类型出现相同需求后再抽象。
- helper 采用直接 import-and-call 风格，暂缓全局 registry。
- `Proposal` 类型保持 single record，view / LLM 视图由 helper 派生。

#### 这条改动 unlocks 什么

1. **解决 `asset.generate` 在前端 / LLM 两端的类型缺口**——这是 P0-a 之后最先需要的层
2. **保持心智负担可控**——只多两个函数，不引入新的注册表 / 抽象层
3. **未来如果有真实需要再统一**——等第二、第三种 codec 写出来后看共性，那时抽象才不会过度设计

---

### 5.3 P1: Hook 加"语义类别"标签

#### 当前问题

`HookResult<P>` 只有 `continue / continue+replace / abort`。8 个 hook event 的"组合语义"没有显式标注：

- 多个插件都注册 `PreToolUse`，是按顺序短路？还是 Promise.all 并发？还是链式 transform？
- 我返回 `null` / 部分对象 / 完整对象，框架怎么处理？
- 我能否阻止后续插件执行？

当前实际行为是"按注册顺序遍历，replace 累积合并"——这个语义只在 `pipeline.ts` 代码里有，没在文档/类型里。这是插件系统的第一大支持问题（"我的 hook 为什么没生效"）。

#### 提议方案

参考 Cherry Studio 的 PluginEngine 设计，给每个 HookEvent 标注语义类别：

```typescript
export type HookSemantic =
  | 'first'        // 顺序遍历，第一个返回非空就短路（"我们在做选择"）
  | 'sequential'   // 链式，前者输出 → 后者输入（"我们在做接力 enrich"）
  | 'parallel'     // Promise.all 并发副作用（"我们在做无副作用的观察"）
  | 'stream';      // 改字节流（未来给 LLM stream transform 用）

export const HOOK_SEMANTICS: Record<HookEvent, HookSemantic> = {
  TurnStart:        'parallel',     // 副作用观察
  PreRuntime:       'sequential',   // 接力 enrich context
  PostRuntime:      'parallel',     // 副作用观察
  PreToolUse:       'sequential',   // 接力改写参数
  PostToolUse:      'parallel',     // 副作用记录
  PreStateCommit:   'sequential',   // 接力修饰 + 任一可 abort 短路（见下方 Codex 评审 #7 注记）
  PostStateCommit:  'parallel',     // 副作用记录
  TurnStop:         'parallel',     // 副作用清理
};
```

> **Codex 评审 #7 修正**：原方案给 `PreStateCommit` 配 `first` 语义（任一插件返回值即短路）。Codex 指出这会**压缩未来的 transform 空间**——例如"权限插件想否决 + 审计插件想加 metadata"两个意图无法共存，因为 `first` 强制只允许第一个插件影响结果。
>
> **改用 `sequential`**：多个插件链式接力修饰 commit payload；任一插件想否决就返回 `abort`（所有 sequential 钩子都支持）。这样 `权限插件 → 修饰插件 → 审计插件` 可以干净叠加。
>
> 如果未来真出现"首个命中 short-circuit"场景，再开 `StateCommitGuard` 这种语义更窄的新 hook。

`HookPipelineRun.run()` 内部按 semantic 分支：
- `first`：遍历到首个返回非 `continue` 的 handler 即停
- `sequential`：链式合并 `replace` 进 payload
- `parallel`：`Promise.allSettled`，只收集错误不影响 payload
- `stream`：复用 AI SDK 的 `experimental_transform`（留给 P1）

排序仍按 `enforce: 'pre' | 'normal' | 'post'`（Vite/Rollup 风格），同 enforce 内按注册顺序。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/hooks/types.ts` | 新增 `HookSemantic` + `HOOK_SEMANTICS` 表 |
| `packages/runtime/src/hooks/pipeline.ts` | `run()` 按 semantic 分支实现 |
| `packages/shared/src/types/plugin.ts` | `HookDeclaration` 加可选 `enforce` 字段 |
| `docs/reference/plugins.md` | 加 hook 语义表（每个 hook 是 first/seq/par） |
| `docs/guide/plugin-authoring.md` | 加"hook 组合行为"章节，告诉插件作者三种语义的差别 |

#### 旧代码可清理

- 当前 `pipeline.ts` 一刀切的"continue+replace 合并"逻辑拆成 4 种实现
- 当前 hook handler 类型 `HookHandler<P>` 可继续用；语义在 pipeline 侧处理。

#### 清理后的后果

> ✅ **2026-04-26 已扫描**：当前 14 个 runtime 中 0 个声明 hook（详见附录 C）。提议的语义标签变化对现有代码**零破坏**，可以无忧推进。

- 即使未来插件依赖被改语义的累积，可以选两条路：(a) 改插件实现使其符合新语义；(b) 把那个 hook 改回 `sequential`。

#### 这条改动 unlocks 什么

1. **IDE 类型推断**直接拒绝错误用法（如在 First 钩子里 throw 而非 return）
2. **插件作者一眼看出多插件叠加是什么行为**——这是插件生态健康度的关键
3. **后续加新 hook（`PreMediaGenerate` / `PostMediaGenerate`）能直接套用语义体系**
4. **RPG 视角的关键收益**：同一个 `PreStateCommit` 可能：多个插件都想**否决** commit（First）、多个想**修饰**（Sequential）、多个想**记录**（Parallel）。如果只有一个 hook 名，三种用法混在一起调试是噩梦——语义标签让"权限插件"和"审计插件"不会互踩。

---

### 5.4 P2: `recursiveCall(deltaInput)` + 深度限制

#### 当前问题

- `turn-executor.ts` 的 tool-call loop 是 hand-rolled while 循环（看 `maxSteps` / `loopDetectionThreshold` 字段）
- 每个 runtime 的"调工具→检查→再调"都自己实现一份
- `loopDetectionThreshold` 只检测同工具同参数连续调用，跨 runtime 递归缺少统一边界
- trace 树形结构不清晰——递归层级看不出来

RPG 一个 turn 的实际推理路径常常是 3-5 层递归：调骰子 → 看结果 → 决定剧情分支 → 查规则书 → 更新状态 → 再调一次 LLM 生成最终叙事。

#### 提议方案

借鉴 Cherry Studio `recursiveCall` + 深度上限：

```typescript
interface RuntimeContextView {
  // ... existing fields
  readonly recursiveCall: (delta: Partial<RuntimeInput>) => Promise<RuntimeResult>;
  readonly recursionDepth: number;  // current depth, 0 at top
}
```

框架内部：
- 维护 `recursionDepth`（默认上限 10，可在 manifest 用 `maxRecursionDepth` 覆盖）
- 超过上限抛 `MaxRecursionExceeded`
- trace 自动生成 `recursiveCall` span 嵌套

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/turn-executor.ts` | 显式记录递归层级，超阈值抛错 |
| `packages/runtime/src/types.ts` | `RuntimeContextView` 加 `recursiveCall` |
| `packages/runtime/src/llm-trace-payload.ts` | trace span 嵌套结构 |
| `apps/web/src/pages/debug/runtime-inspector.tsx` | UI 按嵌套层级渲染 |

#### 旧代码可清理

- 各 runtime 自己实现的"调工具→检查→再调"循环可改为 `recursiveCall`
- `loopDetectionThreshold` 可保留作为局部循环检测，但跨 runtime 的递归走 `recursionDepth`

#### 这条改动 unlocks 什么

1. **prompt 缓存（cache_control）在递归间真正命中**——固定的 9 个 slice 命中缓存，只变化最后一个 slice，token 成本可能差 10 倍
2. **复杂多步推理（dice→分支→更新状态→生成叙事）可用统一语义表达**
3. **trace UI 树形结构清晰**——Langfuse / Phoenix 等观测系统直接受益

---

### 5.5 P2: `ui.render` part 类型化 + 独立 status

#### 当前问题

- `UIRenderInstruction[]` 是单一 spec 数组，没有 part 级 status
- 一个 turn 输出 5 种内容（叙事流式 + 头像图生 + 场景图 + 状态提示 + 骰子动效）必须等所有完成才能渲染
- 单个 part 失败导致整条消息标红 → 其他 4 个内容也看不到了

#### 提议方案

```typescript
type UIPartStatus = 'pending' | 'streaming' | 'success' | 'error' | 'paused';

interface UIRenderPart {
  readonly id: string;            // stable across re-renders
  readonly type: string;          // 'text' | 'image' | 'audio' | 'video' | 'card' | …
  readonly status: UIPartStatus;
  readonly content: unknown;      // typed by `type`
  readonly retry?: { count: number; lastError?: string };
}

interface UIRenderInstruction {
  readonly parts: readonly UIRenderPart[];
  readonly layout?: 'stream' | 'split' | 'overlay';
}
```

旧 `UIRenderInstruction`（无 parts）可以自动 wrap 成 `parts: [{ type, content, status: 'success' }]`（兼容 shim）。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/ui.ts` | `UIRenderPart` 类型 |
| `apps/web/src/components/ui-render/` | 按 `part.type` switch 分发组件 |
| `packages/shared/src/types/protocol.ts` | SSE 协议增加 `ui.part.update` 事件（细粒度推送单个 part 状态） |
| 各 PLUGIN.md `ui.message.json` schema | 升级 schema（兼容旧格式） |

#### 这条改动 unlocks 什么

1. **长篇 RPG 叙事+多模态混排 UI 体验质变**——文本立刻流式出现，图片各自显示 skeleton
2. **单 part 失败只在它自己位置标红**，附"重新生成"按钮，其他内容不受影响
3. **单 part 重生成 / 编辑 / 收藏**——不重建整条消息

---

### 5.6 P1: 内置工具与 MCP 走统一虚拟协议

#### 当前问题

- `builtin tools` 走 hardcoded JS 函数，`local tools` 走插件注册——两套代码路径
- 未来支持真 MCP 时要写第三套
- 工具白名单 / 超时 / 审批 / trace 三套各做一遍

#### 提议方案

借鉴 Cherry Studio `InMemoryTransport` 模式：

```typescript
type ToolTransport = 'in-memory' | 'stdio' | 'http' | 'sse';

interface ToolClient {
  readonly transport: ToolTransport;
  readonly id: string;
  list(): Promise<ToolDefinition[]>;
  call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  close?(): Promise<void>;
}
```

builtin tools 包成一个 `InMemoryToolClient`，每个声明 local tools 的 plugin 包成另一个 `InMemoryToolClient`，未来真 MCP 加 `StdioToolClient` / `HttpToolClient`。

`tool-executor.ts` 只调 `client.call(name, args)`，来源由 registry 解析。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/tools/src/client.ts`（新） | `ToolClient` 接口 |
| `packages/tools/src/in-memory-client.ts`（新） | builtin / local 工具的 in-memory 实现 |
| `packages/tools/src/registry.ts` | 重构为 ToolClient registry |
| `packages/runtime/src/tool-executor.ts` | 只调 `ToolClient.call` |

#### 这条改动 unlocks 什么

1. **工具 trace / 超时 / 错误码一套代码**
2. **用户装第三方 MCP 与调内置工具体验一致**
3. **未来加 `claude-skills` 这类 MCP server 零代码改动**

---

### 5.7 P0-b: 多模态 envelope（单一 `asset.generate`，约束 MediaRef）

> **设计修订（2026-04-26 第二版）**：原方案是按模态拆 `asset.generate` → `media.image` / `media.audio` / `media.video`。但 commit `d9caf04` 已经确立了"框架不为图像 wire 提供 specific 抽象"的原则——按 modality 拆 ProposalType 会**走老路**：每加一种模态都要框架 PR，违反"插件拥有 wire"。
>
> **新方案：保留 `asset.generate` 单一 envelope，但收紧 payload schema 强制引用 MediaRef + 声明 modality**。

#### 当前问题

`asset.generate` payload 完全开放，插件可以塞 base64、URL、混合结构、任意 metadata。两个图像插件实测在 `plugin-data.images` 写：

```js
// dashscope handler
{ imageId, prompt, url, base64, mimeType, status, ... }

// openai handler
{ imageId, prompt, url, base64, mimeType, all: [...], status, ... }
```

base64 直接进 `plugin-data` jsonb 字段 → 1 张 1024×1024 PNG ≈ 1.5 MB → 50 张图就 75 MB。

#### 提议方案

```typescript
// 单一 envelope，不按 modality 拆
interface AssetGeneratePayload {
  /** 引用 MediaStore 里的资产，禁止 inline 大对象。 */
  readonly ref: MediaRef;
  /** Modality 声明，给前端 + trace + audit 用。插件可以声明 'image' / 'audio' / 'video' / 'file' / 'tile' / 任意自定义 */
  readonly modality: string;
  /** 插件自定义元数据（prompt / 参数 / provider 标识等），任意结构。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}
```

**关键点**：
- **modality 取值开放**——插件可以声明 `'image'`、`'audio'`、`'tile'`，甚至将来的 `'3d-model'` / `'lipsync-track'`，框架侧无需每次扩 enum
- **强制 ref 字段必须是 MediaRef**——这是 P0-a 的复用，base64 / URL 必须先 put 到 MediaStore
- **modality 仅作元数据**——框架按 modality 路由到默认 UI 组件（image → gallery、audio → player），模态特定的工具 / Hook / 校验由插件提供

#### Capability discovery 仍走 `RuntimeManifest.capabilities`

第三方插件想做地图、头像、对话、TTS，仍然走当前已有的 `capabilities: string[]` 机制声明能力：

```yaml
# PLUGIN.md
capabilities:
  - image-generation
  - avatar-provider
  - map-tile-provider
  - voice-provider
```

框架按 tag 发现，ProposalType 保持稳定。

#### 框架其他部分需要适配

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/proposal.ts` | `AssetGeneratePayload` 收紧为强制 `ref: MediaRef` + `modality: string` |
| `packages/shared/src/schemas/proposal.ts`（如有） | Zod schema 拒绝 inline base64/blob 字段 |
| `apps/web/src/components/asset-render/` | 按 `modality` 路由：image→gallery、audio→player、其他→generic-link |
| `packages/runtime/src/turn-emitter.ts` | **运行期** warning：插件声明 `capabilities: ['image-generation']` 但本 turn 没 emit `asset.generate`，记一行 warn（不阻断）。Codex 评审 #8 指出加载期无法静态判断 emit 行为，必须移到运行期 |
| `packages/plugin-test-utils/src/contract.ts`（新） | 插件作者写 harness test 时可调 `expectAssetGenerated()` 断言，发布前在 CI 跑 |

#### 现有图像插件迁移清单

两个图像插件需要做的具体改动（与 § 5.1 P0-a 的 handler diff 协同）：

**1. handler 层**：见 § 5.1 P0-a 旧代码清理段——`base64`/`url`/`dataUrl` 字段全部换成 `ref: MediaRef`。

**2. 输出 proposal 层**：当前 handler 通过 `pluginData: [...]` 字段把 `images` namespace 的记录写入 plugin-data，**保留这条路径**（画廊查询索引），**额外**emit 一条 `asset.generate` proposal：

```js
return {
  imageId,
  status: 'done',
  ref: primaryRef,
  prompt,
  promptMode,
  pluginData: [{
    namespace: IMAGES_NAMESPACE,
    key: imageId,
    value: { ...record, ref: primaryRef },  // ref-only record
  }],
  proposals: [{
    type: 'asset.generate',
    payload: {
      ref: primaryRef,
      modality: 'image',
      meta: { prompt, model: resolvedModel, provider: slot.provider, imageId },
    },
  }],
};
```

**3. UI 层**：当前两个插件各画了一份 `gallery.json` / `jobs.json` / `generate-button.json`。三个 spec 都引用 `plugin-data.images.<imageId>.url`（旧字段），需要改成 `plugin-data.images.<imageId>.ref` 然后由框架的 `<Media src={ref}>` 组件解析（解析逻辑在 P0-a 提供的通用组件里）。

**4. 重复 UI 收敛**：dashscope 和 openai 两个插件 UI 高度雷同（gallery 列表、jobs 队列、generate 按钮）。P0 允许两个插件继续保留各自 UI；等两个插件都迁完后，把 `gallery.json` / `jobs.json` 提取成框架级 spec（放 `packages/shared/json-render-presets/`），插件只声明引用。这是 P2 级清理，P0-a/P0-b/P0-c 可先推进。

#### 这条改动 unlocks 什么

1. **不堵插件作者**——想接 Replicate / fal / 本地 SD 都不用等框架 PR，只要走 `resolveSlot` + emit `asset.generate{ ref, modality }`
2. **音频 dedup**：同一句"欢迎来到酒馆" SHA-256 一致 → MediaStore 自然 dedup → 重复 20 次只生成一次
3. **NPC 配音体验质变**：同一个 NPC 在 200 个 turn 里复用同一份声音资产（音色一致 → 沉浸感稳定）
4. **地图 / 头像 / 对话有标准化的发现机制**——第三方插件用 `capabilities` tag 声明能力，框架按 tag 路由 UI

#### 设计边界

- 地图 / 头像 / 对话统一走 `asset.generate{ modality: 'tile'/'avatar'/'dialogue-asset', meta: ... }` 或 `record.upsert`（如对话 session）。
- `modality` 字符串集合保持开放，新模态可以由插件直接声明。
- 每个 modality 的 SDK 选择由插件决定：Vercel AI SDK / DashScope SDK / Replicate Node / 自家 fetch 都可用。

---

### 5.8 后续议题

延后到 P0/P1 至少各跑一轮真实使用后再讨论：

- **sidecar / worker 隔离**：`trust tier` 当前只是"加载与否"开关，运行时仍同进程；社区插件多了之后必须隔离
- **扩展点命名复盘**：避免 OpenWebUI Issue #16409 的命名混乱困境
- **`extensions: Map<string, JSONValue>` 严格类型化**：避免 Cherry Studio `[key: string]: any` 反例
- **README "插件即玩法"差异化文案**：Cherry 反向印证了 Covel 这个差异化的稀缺性

---

## 6. 迁移计划（按 Codex 评审修订：P0 拆为 a/b/c/d 子阶段）

按"零回归 + 分阶段交付"原则。Codex 评审 #11 的推进顺序建议被采纳：把 P0 拆成 4 个独立可 ship 的子阶段，每个都跑端到端再开下一段。

### P0-a：MediaRef 最小基础设施（1 周）— 插件迁移前置能力

- `MediaRef` 类型 + Zod schema（`packages/shared/src/types/media.ts`）
- `MediaStore` 接口 + **仅 Memory + SQLite/local-fs 两个后端**（Codex 评审 #11 缩减范围；PG/S3 / IDB / Tauri 留给 P2）
- `media_assets` + `media_refs` 两张表 schema
- `ctx.media.put` / `get` / `resolveUrl` / `ingestUrl` 注入到 `FunctionHandlerContext`
- `GET /api/media/:id?token=...` 流式输出 + HMAC 签名校验中间件（Codex 评审 #9）
- 前端 `<Media src={ref}>` 组件 + IDB blob 缓存层
- contract test：`packages/store/src/contract/media-store-contract.ts`
- 这一阶段只新增能力；插件迁移从 P0-c 开始。

### P0-b：`asset.generate` 端到端接入 kernel（1-2 周）— 插件迁移前置能力

> Codex 评审 #1 指出当前 `session-kernel.normalizeOutput()` 还缺 `asset.generate` 路径，必须先把这条路径打通才能让 P0-c 的插件迁移有意义。

- `session-kernel.ts` 的 `normalizeOutput()` 接收 runtime handler 的 `output.assets[]` / `output.assetGenerations[]`，转成 `Proposal{ type: 'asset.generate' }`
- commit handler 落 `asset.generate`（持久化、写 `trace_events`、emit `SessionEvent`、推 SSE）
- `ui.render` / `record.upsert` 作为后续独立任务登记在 P2/P3
- 写 `assetGenerateToView()` helper（§ 5.2）
- 前端 `session-store.tsx` 接收 `AssetGenerateView`，按 `modality` 路由组件
- 端到端 fixture 测试（runtime 假装 emit asset → 全链路验证 commit/SSE/render）
- 同步在 `apps/web/src/components/asset-render/` 写图像 / 音频两种默认 modality 渲染器

### P0-c：图像插件迁移到 MediaStore（1 周）

- 按 § 5.1 P0-a 的具体 diff 改 dashscope-image-gen / openai-image-gen handler（每个 ~10 行）
- 两个插件改成额外 emit `asset.generate` proposal（payload `{ ref, modality: 'image', meta }`）
- DashScope 把 OSS URL 改用 `ctx.media.ingestUrl(first.url)`，顺便修掉 24h 过期问题
- `plugin_data.images` 保留作为画廊查询索引，`value` 里只存 ref；base64 通过迁移进入 MediaStore

### P0-d：数据迁移 + snapshot/fork 媒体引用 + 端到端回归（1 周）

- 写 `pnpm migrate:media` 多表扫描脚本（覆盖 § 5.1 列出的 6 张表）
- `SnapshotPayload` 加 `mediaRefs` 字段；fork 时复制 `media_refs` 表行（Codex 评审 #4）
- 全链路回归：生成图 → snapshot → fork → 在 fork session 解析 ref → 验证可读
- staging 环境跑一周观察 `legacy_inline_media` 兜底命中情况

---

### P1：Hook 语义 + 局部 view/LLM helper 收尾 + ToolClient 统一（2-3 周）

- Hook 语义标签 + pipeline 按语义分支重构（§ 5.3，零现存 hook 已确认零破坏）
- 文档（`docs/reference/plugins.md` + `docs/guide/plugin-authoring.md`）补充 hook 语义表
- `assetGenerateToLLM()` 真正生效：先在 `@covel/ai-provider` 设计 `TextMessage.content` 的 content parts 联合（`TextPart | ImagePart | ToolCallPart`），OpenAI / Anthropic adapter 各自按 provider 编码（Codex 评审 #10）
- ToolClient 接口落地（builtin / local 工具统一走 `InMemoryToolClient`）
- 运行期 warning：插件声明 `capabilities: ['image-generation']` 但本 turn 没 emit `asset.generate` → warn（Codex 评审 #8）
- plugin-test-utils 新增 `expectAssetGenerated()` 合约断言

### P2：扩展后端 + 高层抽象（2-3 周）

- `MediaStore` 扩 PG/S3 后端（生产部署）
- `IdbStore` 后端（纯前端模式）
- Tauri command 适配（桌面端 Tauri 走原生 fs API）
- `recursiveCall` + 深度限制（§ 5.4）
- `ui.render` parts 类型化 + 独立 status（§ 5.5）
- 通用 gallery / jobs preset 提取到 `packages/shared/json-render-presets/`

### P3：清理 + 强制约束（1 周）

- 删除 `MessageBlock` / `proposal.payload` 里所有兼容 base64 字段的 shim
- 运行期 warning 升级为 error
- 文档全量更新（`docs/reference/plugins.md`、`docs/guide/plugin-authoring.md`、`docs/reference/protocol.md`）
- `legacy_inline_media` 影子表保留 60 天后删除

---

每阶段都可独立交付、独立 rollback。整体节奏：

| 阶段 | 目标 | 时间 | 依赖 |
|---|---|---|---|
| **P0-a** | MediaRef 基础设施可用 | 1 周 | 无 |
| **P0-b** | `asset.generate` 端到端打通 | 1-2 周 | P0-a |
| **P0-c** | 两个图像插件迁完 | 1 周 | P0-a + P0-b |
| **P0-d** | 数据迁移 + snapshot/fork 收尾 | 1 周 | P0-a + P0-b + P0-c |
| **P1** | Hook 语义、局部 view/LLM helper 收尾、ToolClient 统一 | 2-3 周 | P0 完结 |
| **P2** | 后端扩展、recursiveCall、ui.render parts | 2-3 周 | P1 |
| **P3** | 清理 + 强制约束 | 1 周 | P2 |

总计 **9-13 周**（之前估的 5-7 周低估了 `asset.generate` 端到端接入和 LLM content parts 设计的工作量）。

---

## 7. 风险 / Tradeoffs

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重构面广（6 个 packages） | 短期开发暂停其他 feature | 分 7 阶段（P0-a/b/c/d + P1/P2/P3），每阶段独立 ship；P0-a 可独立启动，P0-b 接在 P0-a 完成后启动 |
| 已发布插件需要适配 | 用户态图像插件要改 | 改动表面积小（每个 handler ~10 行 diff，已写在 § 5.1）；提供 `pnpm migrate:media` 一次性迁移脚本；保留 `legacy_inline_media` 影子表 60 天兜底 |
| Hook 语义改变可能打破现有插件 | 14 个 runtime（10 core-* + 4 用户态） | ✅ **2026-04-26 已扫描，零 hook 声明，零破坏**（附录 C） |
| `MediaRef` 增加一次性查询开销 | 大对象列表渲染慢 | 加 in-memory LRU cache + signed URL 短期缓存 |
| 局部 view / LLM helper 心智负担 | 插件作者需要理解 `asset.generate` 的 record/view/LLM 三种形态 | P0 只做 `asset.generate`；等第二、第三种类型出现同类需求后再抽统一 codec |
| 数据迁移成本（base64 → MediaRef） | 旧 session 存档需要迁移 | 提供 `pnpm migrate:media` 脚本，保留 `legacy_inline_media` 影子表 60 天 |
| 设计过度抽象 | 类型契约太多反而吓走插件作者 | 文档侧重"快速上手"路径，复杂契约只在边界出现 |

---

## 8. 是否必须现在做？

这份 spec 用来比较三个推进时点的成本：

| 选择 | 后果 |
|---|---|
| **延后** | 每加一个新模态插件，重复实现存储 / UI / 重试 / 缓存 / 一致性逻辑。3-4 个插件后开始出现"为什么这个插件的图片无法被另一个插件画廊读取"之类的用户投诉 |
| **半年后启动** | 已有 5-10 个插件按旧模式写，迁移成本可能是现在的 3 倍 |
| **现在启动** | 7 阶段共 9-13 周（详见 § 6 迁移计划修订版），从 P0-a 基础设施一直到 P3 强制约束。两个图像插件的 handler 改动量仍小（每个 ~10 行），但 `asset.generate` 端到端接入 kernel 是新增的真实工作量（P0-b 1-2 周） |

**建议先完成 P0-a/b/c/d**：MediaRef 基础设施、`asset.generate` kernel 接入、两个图像插件迁移、数据迁移与 snapshot/fork 收尾。这条链路完成后，当前图像插件就能从 base64 存储切换到 ref 存储。

P1/P2（Hook 语义、LLM content parts、ToolClient、recursiveCall、ui.render parts）可以在 P0 稳定后按真实插件需求推进。

---

## 9. 待决问题

**MediaStore / 存储层**
- [ ] `MediaStore` 在 Tauri 桌面端是用 fs API 还是 Tauri command？（P2 决定）
- [ ] `MediaStore` 的清理策略（GC、quota、retention）由谁触发——框架还是用户手动？
- [ ] `ctx.media.ingestUrl()` 默认 `maxBytes` 取多少合适？（50 MB 兜得住头像 / 场景图，但视频会超）
- [ ] HMAC 签名 token 的 TTL 设多久？5 分钟够前端展示，但批量画廊翻页可能需要更长

**`asset.generate` 端到端（P0-b）**
- [ ] runtime 输出 schema 用 `output.assets[]` 还是 `output.assetGenerations[]`？（命名一致性）
- [ ] 一个 turn 里同一插件 emit 多个 asset.generate 时，commit 顺序是否需要保证？

**LLM content parts（P1 阻塞 P0-b 完整实现）**
- [ ] `TextMessage.content` 改为 content parts 联合后，向后兼容老 string 路径多久？
- [ ] OpenAI `image_url` vs Anthropic `image source` vs Gemini `inlineData`：base64 还是 URL 优先？

**Hook**
- [ ] Hook 语义改变是否需要 plugin manifest 版本号 bump？（目前零现存 hook，可以延后到 P1）
- [ ] `recursiveCall` 是否应该带"reason"字段方便 trace 阅读？

**迁移 / 兼容**
- [ ] `asset.generate` 接入 kernel commit handler 后，旧 trace（来自 `plugin.data` / `runtime_results` 两条路径）如何呈现？（双显 / lazy migrate / 一次性导出）
- [ ] 多模态 envelope 是否应该有"流式"概念（图像生成中途的 progress 推送给 SSE）？

---

## 10. 下一步

1. **本 spec 评审** → 你决定是否做、做哪些（重点看 § 0.0 Codex 评审 + § 8 是否必须现在做 + § 9 待决问题）
2. 如果决定推进 → 按 § 6 修订后的 P0-a/b/c/d + P1/P2/P3 阶段落地：
   - **P0-a**（1 周）：MediaRef 最小基础设施（Memory + SQLite/local-fs 两后端 + 签名 token + `<Media>` 组件）
   - **P0-b**（1-2 周）：`asset.generate` 端到端接入 kernel（normalizer + commit handler + SSE + web renderer）
   - **P0-c**（1 周）：两个图像插件迁移到 `ctx.media.put` + emit `asset.generate`
   - **P0-d**（1 周）：多表数据迁移脚本 + snapshot/fork 媒体引用收尾
   - **P1**（2-3 周）：Hook 语义、`assetGenerateToLLM` 落地（依赖 ai-provider content parts）、ToolClient 统一
   - **P2**（2-3 周）：扩展后端（PG/S3/IDB/Tauri）+ recursiveCall + ui.render parts
   - **P3**（1 周）：清理兼容 shim + 强制约束 + 文档全量更新
3. 每个阶段各开一个独立 PR，可随时停下来评估
4. **关键依赖链**：P0-a → P0-b → P0-c → P0-d 是串行的，P1 起可以并行
5. **第一个非图像新模态插件出现时**重新评估 P2 的优先级（recursiveCall / ui.render parts 的真实需求强度）

---

## 附录 A: 核心类型定义草案

完整的 `MediaRef`、`MediaStore`、`asset.generate` helper、`HookSemantic`、`UIRenderPart`、`ToolClient` 类型签名见 § 5 各节。落地时统一放在：

```
packages/shared/src/types/media.ts             ← MediaRef
packages/shared/src/types/proposal.ts          ← AssetGeneratePayload
packages/shared/src/proposals/asset-generate.ts ← assetGenerateToView / assetGenerateToLLM
packages/shared/src/types/ui.ts                ← UIRenderPart
packages/runtime/src/hooks/types.ts            ← HookSemantic
packages/store/src/media-store.ts              ← MediaStore 接口
packages/tools/src/client.ts                   ← ToolClient 接口
```

---

## 附录 B: 7 个调研项目对本 spec 的贡献

| 项目 | 关键贡献 | 在本 spec 的位置 |
|---|---|---|
| **LobeChat** | 三层消息分离（DB/UI/LLM）（RFC 142）；S3 + SHA-256 dedup | § 5.1 + § 5.2 |
| **LibreChat** | Zod schema 单一真理 + attachments 引用 | § 5.1 |
| **OpenWebUI** | "Tools 进程内 vs Pipelines 独立 worker"分层；命名混乱反例 | § 5.8 P2 |
| **Vercel AI SDK** | `parts[]` 类型联合 + Generative UI；tool typed I/O | § 5.5 |
| **Big-AGI** | `image_ref` 引用而非内嵌；fragment 化流式 | § 5.1 + § 5.5 |
| **ComfyUI** | typed I/O + 进程隔离 + 反向激励 | § 5.6 + § 5.8 P2 |
| **Cherry Studio** | PluginEngine 四类钩子语义；`recursiveCall` 深度限制；`InMemoryTransport` 统一工具协议；MessageBlock 独立 status | § 5.3 + § 5.4 + § 5.5 + § 5.6 |

---

## 附录 C: 现有插件实测盘点（2026-04-26）

### C.1 总览（14 个 runtime）

| 插件 / Runtime | pluginType | runtimeType | priority | hooks | 关键行为 |
|---|---|---|---|---|---|
| core-pregame | core-plugin | function | 10 | 0 | scheduled, maxTriggerCount=1 |
| core-world-init/schema-gen | core-plugin | agent | 40 | 0 | 仅首轮，写 plugin-data |
| core-char-creator/player-init | core-plugin | agent | 50 | 0 | guard 控制三分支 |
| core-npc-graph/rag-retriever | plugin | function | 400 | 0 | 给 narrator 注入 npcContext |
| core-narrator | core-plugin | agent | 500 | 0 | 主叙事生成 |
| core-guide | plugin | agent | 600 | 0 | 行动建议（并发层） |
| core-codex | plugin | agent | 600 | 0 | 知识图鉴（并发层） |
| core-char-creator/character-tracker | core-plugin | agent | 600 | 0 | 写 character record（并发层） |
| core-npc-graph/extractor | plugin | agent | 600 | 0 | 写 npc-graph nodes/edges（并发层） |
| core-memory | core-plugin | manual UI | — | 0 | 三层记忆面板，UI 事件驱动 |
| dashscope-image-gen/prompt-generator | plugin | agent | — | 0 | manual trigger，生成 prompt + emit event |
| dashscope-image-gen/image-generator | plugin | function | 610 | 0 | event trigger, execution=background |
| openai-image-gen/prompt-generator | plugin | agent | — | 0 | 同上，不同 topic |
| openai-image-gen/image-generator | plugin | function | 610 | 0 | event trigger, execution=background |

### C.2 关键发现

#### Finding 1: 全部 0 个 hook 声明 → P1 Hook 低风险
当前调度全靠 priority + `upstreamRequired` + 事件 + guard。Hook 是新概念，可以**直接定义干净的语义体系**。

#### Finding 2: Priority 600 是 de facto 并发层
4 个 runtime（guide / codex / character-tracker / npc-graph/extractor）都依赖 narrator，框架按 scheduler 把它们并发执行。它们写不同的 plugin-data namespace，**目前无冲突**。如果未来引入 hook，`PostRuntime` 标记 `parallel` 是天然契合的。

#### Finding 3: 图像插件用 `event` + `background` 模拟 hook 行为
两个图像插件都是 "agent prompt-generator emit event → function image-generator 监听执行" 的两段式。这本质上是**用事件机制做了 hook 该做的事**——P1 Hook 语义 + P2 `recursiveCall` 可以让这种模式更轻量。

#### Finding 4: 图像插件全部用 base64 入 plugin-data ⚠️（commit d9caf04 后仍然如此）
两个图像插件的 `image-generator` handler 把 base64 直接写到 `plugin-data.images` namespace：

```js
// dashscope-image-gen/runtimes/image-generator/handler.js
base64: first?.base64 ?? null,
url: first?.url ?? null,
```

```js
// openai-image-gen/runtimes/image-generator/handler.js:328-330
const base64 = typeof first.base64 === 'string' ? first.base64 : null;
const mimeType = typeof first.mediaType === 'string' ? first.mediaType : 'image/png';
const dataUrl = base64 ? `data:${mimeType};base64,${base64}` : null;
```

一张 1024×1024 PNG 的 base64 ≈ 1.5 MB。如果一个 session 生成 50 张图，`plugin_data` 表的 jsonb 字段会膨胀到 75 MB。**这正是 P0-a MediaRef 要解决的痛点**。

> **commit `d9caf04` 后的现状**：wire 层已完美拆出（dashscope 自己包 wan2.x 异步轮询、openai 用 Vercel AI SDK v6），但**存储层仍是 base64 入 jsonb**。这是 P0-a 的剩余空间——把 base64 → MediaRef，让 `plugin_data.images` 只存引用。

#### Finding 4b: 框架已有部分原语（d9caf04 引入）✅
新 commit 已经把这些原语放进 `ctx`：

| 原语 | 来源 | 用途 |
|---|---|---|
| `gateway.resolveSlot({ presetId, fallbackTag })` | `@covel/ai-provider` 经 `plugin-runtime-gateway.ts` | 拿 `{ provider, baseUrl, apiKey, model, headers }` 走 llm.toml |
| `ctx.utils.validateBaseUrl(url)` | `@covel/ai-provider/plugin-utils.ts` | SSRF guard（RFC1918 + cloud metadata） |
| `ctx.utils.fetchWithRetry(url, init)` | 同上 | 指数退避 + Retry-After 处理 |

**这意味着 P0-a MediaStore 是这套原语集合里"最后一个缺的"**——存储原语缺位，所以插件还在用 plugin-data 当存储兜底。补上 MediaStore 后，`ctx.media.put(...)` 与上述三个原语并列，插件就有完整的"L1 Media 原语集"。

#### Finding 5: 全部 UI 是 JSON spec，无 React .tsx
这意味着采用 § 5.5 的 `UIRenderPart` 部分类型化路径**无需迁移自定义 React 组件**——只需升级 json-render 的 schema 即可。

#### Finding 6: 两个图像插件 UI 高度重复
`dashscope-image-gen` 和 `openai-image-gen` 都各自实现了 `gallery.json` / `jobs.json` / `generate-button.json`——**已经是"每个插件重复造一遍 UI"问题的实证**。spec § 1.2 描述的痛点来自当前代码。

### C.3 Hook 语义建议

基于盘点，建议的 `HOOK_SEMANTICS` 默认值：

| Hook | 语义 | 理由 |
|---|---|---|
| `TurnStart` | `parallel` | 副作用观察（日志、metrics 等） |
| `PreRuntime` | `sequential` | 接力 enrich context（潜在用例：LoreBook、记忆注入） |
| `PostRuntime` | `parallel` | 副作用记录（trace、analytics） |
| `PreToolUse` | `sequential` | 接力改写参数（潜在用例：参数审查、注入） |
| `PostToolUse` | `parallel` | 副作用记录 |
| `PreStateCommit` | `sequential` | 接力修饰；任一插件可通过返回 `abort` 短路否决（Codex 评审 #7 修订） |
| `PostStateCommit` | `parallel` | 副作用记录 |
| `TurnStop` | `parallel` | 副作用清理 |

由于零现存使用，可以直接落地这套默认值，未来如果某个 hook 出现"必须串行修饰"的场景再调整。

---

## 附录 D: 总体意义

这份 spec 的核心目标只有一句话：**让"插件作者"和"框架开发者"通过稳定契约协作。**

- `MediaRef` 把存储后端差异收进框架。
- `asset.generate` 局部 view / LLM helper 把前端视图和 provider 编码差异收进共享 helper。
- Hook 语义标签把执行顺序写进类型和文档。
- `recursiveCall` 把循环管理收进 runtime。
- per-part status 把 UI 一致性收进协议。
- 统一 ToolClient 协议让内置和第三方插件走同一条 trace。
- 严格类型让框架升级具备可验证边界。

每多一条这样的契约，Covel 就多一类**框架团队介入很少也能做出来的插件**。这是"插件即玩法"框架真正的护城河——**插件作者的产能 / 框架团队的产能 = 插件生态的天花板**。Cherry / Lobe / LibreChat 这个比值都接近 1（社区贡献基本只能改 CSS / 加 provider），Covel 现在已经有机会把这个比值做到 10:1 甚至 100:1，前提是**这些契约定得足够干净**。
