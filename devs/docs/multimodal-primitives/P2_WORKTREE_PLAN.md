# P2 Worktree Plan

**目标**：并行完成 P2 扩展后端与高层抽象，主工作区负责集成、合并、测试与文档收口。

**基准**：所有 P2 worktree 从 `main` 的当前 HEAD 创建。

## Worktree 划分

| Worktree                     | Branch                  | 负责人 | 职责                                                                                                       |
| ---------------------------- | ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `.worktrees/p2-media-pg-s3`  | `agent/p2-media-pg-s3`  | Codex  | `MediaStore` PG 后端、S3/R2-compatible 后端接口、media store contract、现有 SQLite/local-fs contract 覆盖  |
| `.worktrees/p2-idb-media`    | `agent/p2-idb-media`    | Claude | IndexedDB media blob 后端、前端纯浏览器 media read/write、`MediaRef` / `MediaStore` 类型对齐、浏览器侧测试 |
| `.worktrees/p2-tauri-media`  | `agent/p2-tauri-media`  | Claude | Tauri command 适配、桌面端 native fs media read/write、前端调用层封装、desktop bridge 测试                 |
| `.worktrees/p2-ui-recursive` | `agent/p2-ui-recursive` | Codex  | `recursiveCall` + 深度限制、`ui.render` parts 类型化、独立 status model、runtime/tool trace 测试           |

## 文件边界

### A. `p2-media-pg-s3`

主要写入范围：

- `packages/store/src/**`
- `packages/store/tests/**`
- `packages/shared/src/**` 中 media store 必需类型
- `docs/reference/**` 中 media store contract 说明

验收命令：

- `mise exec -- pnpm --filter @covel/store test`
- `mise exec -- pnpm --filter @covel/store lint`
- `mise exec -- pnpm --filter @covel/shared lint`

### B. `p2-idb-media`

主要写入范围：

- `packages/store/src/indexeddb/**`
- `apps/web/src/**` 中 browser media adapter
- `packages/shared/src/**` 中 browser media 必需类型

验收命令：

- `mise exec -- pnpm --filter @covel/store test`
- `mise exec -- pnpm --filter @covel/store lint`
- `mise exec -- pnpm --filter @covel/web lint`

### C. `p2-tauri-media`

主要写入范围：

- Tauri / desktop bridge 相关目录
- `apps/web/src/**` 中 desktop media adapter
- 相关测试与文档

验收命令：

- `mise exec -- pnpm --filter @covel/web lint`
- desktop / tauri package 的现有测试命令

### D. `p2-ui-recursive`

主要写入范围：

- `packages/runtime/src/**`
- `packages/tools/src/**`
- `packages/shared/src/**` 中 `ui.render` / recursive call 必需类型
- `docs/reference/tools.md`
- `docs/reference/plugins.md`

验收命令：

- `mise exec -- pnpm --filter @covel/runtime test`
- `mise exec -- pnpm --filter @covel/runtime lint`
- `mise exec -- pnpm --filter @covel/tools test`
- `mise exec -- pnpm --filter @covel/tools lint`
- `mise exec -- pnpm --filter @covel/shared lint`

## 合并顺序

1. `p2-media-pg-s3`
2. `p2-idb-media`
3. `p2-tauri-media`
4. `p2-ui-recursive`
5. 主工作区更新 `SPEC.md`、运行 P2 聚合测试、提交收口 commit

## 主工作区职责

- 审查各 agent diff
- 统一跨包 API 命名
- 解决类型冲突
- 运行聚合测试
- 合并后更新 `devs/docs/multimodal-primitives/SPEC.md`
