# Turn-Band 硬分离修复 — Design

**Date:** 2026-04-17
**Author:** session-driven brainstorm
**Status:** Draft — pending review
**Related:** `packages/runtime/src/scheduler.ts`, `packages/runtime/src/trigger.ts`, `packages/runtime/src/turn-executor.ts`, `packages/shared/src/types/session.ts`

---

## 背景

当前 `packages/runtime` 的优先级带（priority bands）只是 CLAUDE.md 里的文档约定，内核层不强制。并行存在两套调度语义：

- **插件 `trigger.phases: [playing]`** — 按 session phase 屏蔽主循环 runtime
- **`playingTurnOffset` / `playingTurnNumber`** — 补丁式的"进入 playing 后计数器"

结果：

1. `core-char-creator/player-init` 放在 priority 700（After-Turn band），但它本质上是**游戏前的角色创建**流程
2. `SessionPhase` 字段（`'pre-game' | 'playing' | 'paused' | 'ended'`）承担了 5 个不同职责，很多是可派生的
3. 插件作者必须在每个 PLUGIN.md 里重复声明 `phases: [playing]`
4. Turn 0（Pre-Game）和 Turn 1+（主循环）的边界全靠 `maxTriggerCount: 1` 这种间接手段维护

## 目标

建立**内核强制的 turn-band 硬绑定**：turn number 直接决定哪些 priority 范围被调度，消除 `SessionPhase` 字段和 `playingTurnOffset`，把状态数量压到最少。

## 非目标

- 不改 paused / ended 的语义，只是把它们从 phase 搬到独立 `status` 字段
- 不重构插件以外的无关调度逻辑
- 不改前端 `AppPhase`（那是前端 UI 状态机，跟后端无关）

---

## §1 模型核心

**Turn ↔ Priority Band 硬绑定**（内核强制）：

| Turn | 调度的 priority 范围 | 阶段 | 可迭代 |
|------|--------------------|------|-------|
| 0 | 0-99 | Pre-Game | ✅ 反复进入直到所有 runtime 报 `preGameDone` |
| ≥1 | 100-1000 | 主循环（Pre-Turn / Narrator / After-Turn / Audit） | 每次玩家提交 turn+1 |

### Pre-Game 完成信号（Turn 0 递增规则）

**状态**：内核维护 session 级 `preGameCompleted: Set<runtimeId>`（存在 sessions 表的 `pre_game_completed` JSONB 列，默认 `[]`）。

**runtime 进入 `preGameCompleted` 的条件**（满足任一即加入）：

- runtime 输出 `preGameDone: true`
- runtime 被 guard 跳过（视同完成）
- runtime 因 `maxTriggerCount` 达上限不再被调度（视同完成，典型是一次性 function runtime）

**Turn 0 推进条件**（每次玩家提交后检查）：

会话激活的 Pre-Game band（priority 0-99）所有 runtime 的 `runtimeId` 全集 ⊆ `preGameCompleted` → `turnCount = 1`，否则保持 0 允许下一次迭代。

"激活"指被 `SessionPluginScope` 启用且 `plugin.json` 注册的 runtime — **不**考虑当轮 trigger 是否满足，否则玩家还没提交表单时 player-init 的 trigger 可能不命中就导致它被提前 pass。

**一旦某 runtime 进 `preGameCompleted`，Turn 0 剩余迭代中内核不再调度它**（即使 trigger 仍匹配）。避免 pregame 在 Turn 0 的第 2/3 次迭代被重跑。

`preGameDone` 字段：

- runtime 输出里的可选布尔字段，默认 `false`
- 只在 Pre-Game band 有意义；主循环 runtime 即使带 `preGameDone: true` 也被忽略

### SessionRecord 字段变化

- ❌ 删除 `phase: string`
- ❌ 删除 `playingTurnOffset: number | null`
- ✅ 新增 `status: 'active' | 'paused' | 'ended'`（默认 `active`）
- ✓ 保留 `turnCount: number`（语义增强为"band 选择器"）

### 派生量（不存字段，按需计算）

- `isPreGame = turnCount === 0`
- `isPlaying = turnCount >= 1`

---

## §2 内核改动

### `packages/runtime/src/scheduler.ts`

`scheduleByPriority` 增加 `turnNumber` 参数，按 turn 过滤 band：

```
turn === 0 → 只保留 priority ∈ [0, 99]
turn >= 1  → 只保留 priority ∈ [100, 1000]
```

越界的 runtime 在该 turn 被静默跳过（`pino.debug` 日志，非 warn，避免产线噪声）。

### `packages/runtime/src/trigger.ts`

- 删除 `trigger.phases` 字段支持（废弃）
- 删除 `context.sessionPhase`
- 删除 `context.playingTurnNumber`
- `trigger.startTurn` 改为比较 `turnNumber - 1`（即"主循环的第 N 轮"；`turn === 0` 时不适用 startTurn，直接被 band-filter 挡住）

### `packages/runtime/src/turn-executor.ts`

- 删除 `playingTurnOffset` 初始化逻辑（现 488-504 行整段）
- 删除 `sessionPhase` 跟踪（在 `sessionMeta` 里也删）
- 删除 runtime 输出里的 `phase` 转换（现 624-630 行）
- 新增 Turn 0 完成检查：turn 结束时如果 `turnCount === 0` 且所有 scheduled Pre-Game runtime 都 `preGameDone: true`，则 `updateSession({ turnCount: 1 })`
- turn 的递增在**所有 runtime 完成后**统一处理，不分散到工具里

### `packages/runtime/src/types.ts`

`TriggerContext`：

- 删除 `sessionPhase`
- 删除 `playingTurnNumber`
- 保留 `turnNumber`

### `RuntimeOutput` 类型

`packages/shared/src/types/runtime-output.ts` 和 `packages/shared/src/types/proposal.ts`：

- ❌ 删 `phase: string`
- ✅ 新增 `preGameDone?: boolean`

对应 Zod schema（`packages/shared/src/schemas/runtime-output.ts`）同步。

---

## §3 插件改动

### 删 `trigger.phases` 声明

6 个 PLUGIN.md 需要删除 `phases:` / `- playing` 两行：

- `plugins/core-narrator/PLUGIN.md` + `.en.md`
- `plugins/core-guide/PLUGIN.md`
- `plugins/core-codex/PLUGIN.md` + `.en.md`
- `plugins/core-npc-graph/runtimes/extractor/PLUGIN.md`
- `plugins/core-npc-graph/runtimes/rag-retriever/PLUGIN.md`
- `plugins/core-char-creator/runtimes/character-tracker/PLUGIN.md`

### player-init 归位

`plugins/core-char-creator/runtimes/player-init/PLUGIN.md`：

- priority `700 → 50`（Pre-Game band）
- `maxTriggerCount: 3` 删除 — Turn 0 迭代上限由 `preGameDone` 控制
- agent 完成 `create-character` 调用后，输出 `preGameDone: true`
- 未完成（还在等表单提交）时，输出 `preGameDone: false` 或省略该字段
- 删除 `create-character` 工具的 `transitionPhase: "playing"` 调用（工具本身也删这个参数）

### Pre-Game band 的其他 runtime

- `core-pregame` (priority 10)：function runtime，handler 返回 `preGameDone: true`
- `core-world-init/schema-gen` (priority 85)：agent runtime，2 次工具调用完成后输出 `preGameDone: true`；guard 跳过时内核自动视同完成

### core-memory

- 无 runtime，纯 UI 插件
- 删除 `priority: 900`（无意义）
- 保留 `trigger: { type: manual }` 和 `ui.right` 声明
- 内核对 `handler` 和 `runtimeType` 都未声明的 plugin.json **不调度**

### 保持不变的插件

- `core-npc-graph/rag-retriever` priority 490（Pre-Turn）
- `core-npc-graph/extractor` priority 620（After-Turn）
- `core-narrator` 500、`core-guide` 550、`core-codex` 650、`character-tracker` 750

---

## §4 工具 / API / 前端

### `packages/tools/src/builtin/character-tools.ts`

- 删除 `create-character` 工具的 `transitionPhase` 参数（schema + 实现）
- 删除 `onPhaseTransition` 回调
- 工具只负责写 characters 表；turn 推进交给内核

### `apps/server/src/routes/api/session.ts`

- `POST /api/sessions` 默认字段：`{ turnCount: 0, status: 'active' }`（移除 `phase: 'pre-game'`）
- `PATCH /api/sessions/:id`：接收 `status` 代替 `phase`
- 删除 `VALID_PHASES` 常量

### `apps/server/src/routes/api/bootstrap.ts`

- 删除 `phase.changed` SSE 触发器（现 253 行附近）
- 新增 `status.changed` SSE（仅在 paused/ended 时发）

### 前端（apps/web-v2）

- `api.SessionRecord` 类型：`phase: SessionPhase → status: SessionStatus`
- `session-store.ts`：
  - `AppPhase` 保留不变（`"loading" | "world-select" | "session-prep" | "playing"` 是前端 UI 状态机）
  - 原本 `session.phase === 'playing'` 改为 `(session.turnCount ?? 0) >= 1`
- `debug-page.tsx`：绿灯判断按 `turnCount` 派生
- `session-prep.tsx`：`phaseLabel()` 改为 `turnLabel(turnCount)`

### 旧 V1 前端（apps/web）

legacy 但仍在跑，需同步：

- `apps/web/src/services/api.ts`：`SessionPhase` → `SessionStatus`
- `apps/web/src/services/data-service.ts`：所有 `phase: 'init'` 初始化改为 `turnCount: 0, status: 'active'`
- `apps/web/src/routes/session.tsx`、`apps/web/src/components/session/*.tsx`：所有 `phase === 'playing'` 改为 `turnCount >= 1`

### `packages/context/src/prompt-internals.ts`

第 369 行注入的 `phase` 字段改为派生：

```typescript
phase: turnCount === 0 ? 'pre-game' : 'playing'
```

LLM 层对外的接口保持字符串（不影响 prompt 模板），只是后端不再存这个字段。

---

## §5 数据迁移

**破坏式迁移**（无公开发布，数据价值低）：

### PostgreSQL migration

新文件 `packages/store/src/postgres/migrations/00XX_turn_bands.sql`：

```sql
ALTER TABLE sessions DROP COLUMN phase;
ALTER TABLE sessions DROP COLUMN playing_turn_offset;
ALTER TABLE sessions ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN pre_game_completed jsonb NOT NULL DEFAULT '[]'::jsonb;
```

通过 `pnpm db:generate` + `pnpm db:migrate` 应用。

### SQLite

`packages/store/src/sqlite/schema.ts` 同步修改；本地开发环境直接删 `.sqlite` 文件重建。

### IndexedDB（前端 T1/T2）

schema 版本升级，旧 session 在 migration 中清空（IDB 没有 alter column，整库 version bump + 清 object store）。

### Shared 类型

`packages/shared/src/types/session.ts`：

```typescript
// 删除
export type SessionPhase = 'pre-game' | 'playing' | 'paused' | 'ended';

// 新增
export type SessionStatus = 'active' | 'paused' | 'ended';

export interface SessionRecord {
  // ... 其他字段
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly preGameCompleted: readonly string[]; // runtimeId 列表
  // 删除: phase, playingTurnOffset
}
```

### 测试数据

所有测试文件里的 `phase: 'playing' | 'pre-game' | 'character_creation'` 替换：

- `phase: 'playing'` → `turnCount: 1, status: 'active'`
- `phase: 'pre-game'` → `turnCount: 0, status: 'active'`
- `phase: 'character_creation'` → `turnCount: 0, status: 'active'`（character_creation 本身在新模型下不是独立状态）
- `phase: 'ended'` → `status: 'ended'`
- `phase: 'paused'` → `status: 'paused'`

受影响的测试文件（不完整清单，实施时以 grep 为准）：

- `packages/store/src/contract/store-contract.ts`
- `packages/store/src/contract/vector-store-contract.ts`
- `plugins/core-narrator/tests/v1-v2-parity.test.ts`
- `plugins/core-guide/tests/v1-v2-parity.test.ts`
- `plugins/core-char-creator/tests/v1-v2-parity.test.ts`
- `plugins/core-world-init/guard.test.ts`
- `packages/tools/tests/character-tools.test.ts`
- `apps/server/tests/api/*.test.ts`（约 7 个文件）
- `packages/runtime/tests/*.test.ts`

---

## §6 文档同步

按 CLAUDE.md 的 Documentation Sync Rules：

| 文件 | 改动 |
|------|------|
| `CLAUDE.md` | 更新 "Priority Scheduler" 段为 turn-band 硬分离语义；更新 Plugin Inventory 表（player-init 改 50、删 phase 列、移除 core-memory 的 priority 行）；删除 `SessionPhase` / `playingTurnOffset` 相关描述；新增 `SessionStatus` 说明；更新 Server Bootstrap 相关描述 |
| `docs/reference/plugins.md` | 更新所有插件 priority 和 trigger 描述；删除 `phases:` 字段文档 |
| `docs/reference/api.md` | `PATCH /sessions/:id` 改 `status`，删 `phase`；`POST /sessions` 默认值更新 |
| `docs/reference/protocol.md` | 删除 `phase.changed` SSE 事件；新增 `status.changed` |
| 各 PLUGIN.md 的 "执行时机" 段 | 反映新的 band 含义（特别是 core-pregame、schema-gen、player-init 的 README） |

---

## 实施顺序建议

1. **Schema / 类型层**：`SessionRecord`、`SessionStatus`、`RuntimeOutput.preGameDone`、store schemas、migration 文件
2. **内核层**：`scheduler.ts` band-filter、`trigger.ts` 删 phase、`turn-executor.ts` 删 playingTurnOffset + 新增 Turn 0 完成检查
3. **工具层**：`create-character` 删 `transitionPhase`
4. **插件层**：删 `phases` 声明、player-init 改 priority、加 `preGameDone` 输出
5. **API / 前端**：session 路由、前端类型、prompt 注入派生
6. **测试层**：批量替换
7. **文档**：CLAUDE.md + docs/reference/

每一层完成后跑对应包的 test，保证增量可验证。

---

## 验收标准

- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 全绿
- [ ] 新 session 创建后 `SELECT * FROM sessions` 看不到 `phase` / `playing_turn_offset` 列，有 `status`
- [ ] E2E 脚本 `scripts/e2e-plugin-verify.ts` 完成一次 pre-game → playing → 3 轮主循环，中间不出现 `phase` 字段写入
- [ ] CLAUDE.md 的 Plugin Inventory 与实际 PLUGIN.md 一致
- [ ] 搜索全仓 `grep -r "trigger.phases\|playingTurnOffset\|SessionPhase\|transitionPhase"` 无业务代码命中（只剩 migration/历史 commit）

---

## 风险与缓解

1. **破坏式迁移，旧 session 丢失** — 项目未公开发布，可接受。开发环境清 DB 即可。
2. **V1 前端同步漏改导致编译断** — 实施时必须把 V1、V2 两侧类型都过一遍，`pnpm lint` 兜底。
3. **`phase.changed` SSE 下游消费者** — 目前仅前端 `session-store.ts` 监听，一并改。
4. **Pre-Game runtime 不输出 `preGameDone` 导致 Turn 0 永远不推进** — 在 `turn-executor.ts` 里加兜底日志：连续 N 次 Turn 0 迭代仍无 runtime 报 `preGameDone: true` 时发 warning，便于定位配置错误插件。N 默认 5。
