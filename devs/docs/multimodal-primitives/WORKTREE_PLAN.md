# 多 Agent Worktree 执行计划

**目标**：用 `.worktrees/` 承载本仓库的并行 worktree，让 Codex 与 Claude 分别处理边界清晰的任务，主线按阶段合并。

**当前约定**

- 所有 worktree 放在仓库根目录的 `.worktrees/` 下。
- `.gitignore` 已包含 `.worktrees/`。
- 每个 agent 使用独立 branch + 独立 worktree。
- 每个 agent 只改自己的写入范围；跨范围需求写进最终交付说明。
- 当前主线程作为 coordinator，负责创建 worktree、发任务、合并、跑总测试。

## 0. 基准分支

先建立一个所有 agent 共同继承的基准分支：

```bash
git switch -c feature/multimodal-primitives-base
git add devs/docs/multimodal-primitives/SPEC.md \
  devs/docs/multimodal-primitives/WORKTREE_PLAN.md \
  .gitignore
git commit -m "docs: plan multimodal primitives worktrees"
```

后续所有 worktree 从 `feature/multimodal-primitives-base` 创建。

## 1. Worktree 创建清单

```bash
mkdir -p .worktrees

git worktree add .worktrees/codex-p0a-media-store \
  -b agent/codex-p0a-media-store feature/multimodal-primitives-base

git worktree add .worktrees/codex-p0a-runtime-media \
  -b agent/codex-p0a-runtime-media feature/multimodal-primitives-base

git worktree add .worktrees/claude-p0a-media-api \
  -b agent/claude-p0a-media-api feature/multimodal-primitives-base

git worktree add .worktrees/claude-p0a-media-web \
  -b agent/claude-p0a-media-web feature/multimodal-primitives-base

git worktree add .worktrees/codex-p0b-asset-kernel \
  -b agent/codex-p0b-asset-kernel feature/multimodal-primitives-base

git worktree add .worktrees/claude-p0b-asset-web \
  -b agent/claude-p0b-asset-web feature/multimodal-primitives-base

git worktree add .worktrees/claude-p0c-dashscope-plugin \
  -b agent/claude-p0c-dashscope-plugin feature/multimodal-primitives-base

git worktree add .worktrees/claude-p0c-openai-plugin \
  -b agent/claude-p0c-openai-plugin feature/multimodal-primitives-base

git worktree add .worktrees/codex-p0d-media-migration \
  -b agent/codex-p0d-media-migration feature/multimodal-primitives-base

git worktree add .worktrees/codex-p0d-snapshot-fork \
  -b agent/codex-p0d-snapshot-fork feature/multimodal-primitives-base
```

实际启动按阶段分批执行。第一批建议只创建 P0-a 的 4 个 worktree。

## 2. 第一批：P0-a 基础设施

### Codex A：MediaStore Core

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/codex-p0a-media-store` |
| Branch | `agent/codex-p0a-media-store` |
| 目标 | 实现 `MediaRef`、`MediaStore` 接口、Memory 后端、SQLite/local-fs 后端、contract tests |
| 写入范围 | `packages/shared/src/types/media.ts`、`packages/store/src/media-store.ts`、`packages/store/src/contract/media-store-contract.ts`、`packages/store/src/schema/*` |
| 交付 | 类型导出、store 实现、contract test、迁移说明 |
| 验证 | store 相关 unit / contract tests |

### Codex B：Runtime Media Context

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/codex-p0a-runtime-media` |
| Branch | `agent/codex-p0a-runtime-media` |
| 目标 | 把 `ctx.media` 注入 function runtime，提供 `put/get/resolveUrl/ingestUrl` |
| 写入范围 | `packages/plugin-loader/src/types.ts`、`packages/runtime/src/plugin-handler-helpers.ts`、`packages/runtime/src/turn-executor.ts`、runtime media helper 文件 |
| 交付 | `FunctionHandlerContext.media`、安全远程 ingest helper、runtime wiring |
| 验证 | runtime handler helper tests、SSRF/redirect/maxBytes/MIME sniff 测试 |

### Claude A：Media API

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/claude-p0a-media-api` |
| Branch | `agent/claude-p0a-media-api` |
| 目标 | 实现 `/api/media/:id?token=...`、HMAC 短期 token、server route wiring |
| 写入范围 | `apps/server/src/routes/api/media.ts`、`apps/server/src/middleware/media-token.ts`、server route index |
| 交付 | signed URL 校验、streaming response、权限失败错误码 |
| 验证 | route tests、token TTL tests、跨 session 权限 tests |

### Claude B：Web Media Component

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/claude-p0a-media-web` |
| Branch | `agent/claude-p0a-media-web` |
| 目标 | 前端支持 `MediaRef` 渲染，`Image` / `Media` 组件读取 signed URL |
| 写入范围 | `apps/web/src/components/Media.tsx`、`apps/web/src/lib/catalog.tsx`、`apps/web/src/stores/*` 中的媒体缓存相关文件 |
| 交付 | `<Media src={ref}>`、`Image` ref 输入兼容、IDB blob cache |
| 验证 | component tests、json-render fixture、浏览器 smoke test |

**P0-a 合并顺序**

1. `codex-p0a-media-store`
2. `codex-p0a-runtime-media`
3. `claude-p0a-media-api`
4. `claude-p0a-media-web`

合并后跑总测试，确认 `MediaRef + ctx.media + /api/media + web ref 渲染` 链路可用。

## 3. 第二批：P0-b `asset.generate` Kernel

### Codex C：Asset Kernel

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/codex-p0b-asset-kernel` |
| Branch | `agent/codex-p0b-asset-kernel` |
| 目标 | 接入 `asset.generate` normalizer、commit handler、trace、SSE、`assetGenerateToView()` |
| 写入范围 | `packages/runtime/src/session-kernel.ts`、`packages/runtime/src/turn-emitter.ts`、`packages/runtime/src/prompt-delta.ts`、`packages/shared/src/proposals/asset-generate.ts`、shared proposal schema |
| 交付 | `output.assets[]` / `output.assetGenerations[]` 到 `Proposal{ type: 'asset.generate' }` 的端到端路径 |
| 验证 | kernel fixture、trace/SSE snapshot、runtime fake asset test |

### Claude C：Asset Web Renderer

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/claude-p0b-asset-web` |
| Branch | `agent/claude-p0b-asset-web` |
| 目标 | Web 接收 `AssetGenerateView`，按 `modality` 渲染默认 image / audio / generic-link |
| 写入范围 | `apps/web/src/stores/session-store.tsx`、`apps/web/src/components/asset-render/*`、web fixtures |
| 交付 | asset renderer、pending/committed/error 状态展示、modality routing |
| 验证 | store tests、component tests、Playwright smoke test |

**P0-b 合并顺序**

1. `codex-p0b-asset-kernel`
2. `claude-p0b-asset-web`

## 4. 第三批：P0-c 图像插件迁移

### Claude D：DashScope Plugin

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/claude-p0c-dashscope-plugin` |
| Branch | `agent/claude-p0c-dashscope-plugin` |
| 目标 | DashScope 图片插件迁移到 `ctx.media.ingestUrl()` / `ctx.media.put()`，额外 emit `asset.generate` |
| 写入范围 | DashScope 图片插件目录、对应 UI spec、插件测试 |
| 交付 | ref-only `plugin_data.images`、`asset.generate` proposal、OSS URL 过期问题收口 |
| 验证 | plugin unit test、mock handler test、manual fixture |

### Claude E：OpenAI Plugin

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/claude-p0c-openai-plugin` |
| Branch | `agent/claude-p0c-openai-plugin` |
| 目标 | OpenAI 图片插件迁移到 `ctx.media.put()`，额外 emit `asset.generate` |
| 写入范围 | OpenAI 图片插件目录、对应 UI spec、插件测试 |
| 交付 | ref-only `plugin_data.images`、`asset.generate` proposal、multi-image refs |
| 验证 | plugin unit test、mock handler test、manual fixture |

**P0-c 合并顺序**

1. `claude-p0c-dashscope-plugin`
2. `claude-p0c-openai-plugin`

## 5. 第四批：P0-d 迁移与 Snapshot/Fork

### Codex D：Media Migration

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/codex-p0d-media-migration` |
| Branch | `agent/codex-p0d-media-migration` |
| 目标 | 实现 `pnpm migrate:media` 多表扫描和 `legacy_inline_media` 影子表 |
| 写入范围 | `scripts/*`、store migration/schema、migration tests |
| 交付 | 多表扫描、批量迁移、单条失败继续、回滚索引 |
| 验证 | migration fixtures、SQLite integration test |

### Codex E：Snapshot / Fork Media Refs

| 项 | 内容 |
|---|---|
| Worktree | `.worktrees/codex-p0d-snapshot-fork` |
| Branch | `agent/codex-p0d-snapshot-fork` |
| 目标 | `SnapshotPayload.mediaRefs`，fork 时复制 `media_refs` 引用关系 |
| 写入范围 | `packages/runtime/src/snapshot-payload-builder.ts`、`apps/server/src/routes/api/snapshots.ts`、store fork helper/tests |
| 交付 | snapshot 收集 refs、fork session 继承 refs、端到端 fixture |
| 验证 | snapshot/fork integration test |

**P0-d 合并顺序**

1. `codex-p0d-media-migration`
2. `codex-p0d-snapshot-fork`

## 6. Coordinator 职责

Coordinator 建议由当前 Codex 主线程承担：

- 创建基准分支和 worktree。
- 给每个 agent 发任务 prompt，包含写入范围、验收标准、测试命令。
- 收 agent 交付，逐个合并到 integration branch。
- 解决跨分支冲突。
- 跑总测试和端到端 smoke。
- 更新 `SPEC.md` 的已完成状态。

## 7. Agent 交付格式

每个 agent 完成后输出：

```text
Agent:
Worktree:
Branch:
Changed files:
Implemented:
Tests run:
Remaining risks:
Downstream notes:
```

## 8. 合并策略

每个阶段建立一个 integration branch：

```bash
git switch -c integration/p0a-media feature/multimodal-primitives-base
git merge --no-ff agent/codex-p0a-media-store
git merge --no-ff agent/codex-p0a-runtime-media
git merge --no-ff agent/claude-p0a-media-api
git merge --no-ff agent/claude-p0a-media-web
```

P0-a 验证通过后，把 `integration/p0a-media` 作为 P0-b 的新基准。后续阶段同理。

## 9. 清理命令

阶段合并完成后可清理对应 worktree：

```bash
git worktree remove .worktrees/codex-p0a-media-store
git branch -d agent/codex-p0a-media-store
```

批量清理前先执行：

```bash
git worktree list
git branch --list 'agent/*'
```
