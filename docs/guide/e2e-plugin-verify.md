# E2E Plugin Verification 脚本

`scripts/e2e-plugin-verify.ts` 是 Covel 的插件级端到端测试工具。它**完全通过 HTTP API 驱动**整个游戏流水线（不需要点前端），逐轮观测每个 runtime 的执行状态、工具调用和触发行为，并把日志和 artefact 持久化到 `debugs/e2e-logs/` 下。

> 设计目标：热加载插件后不需要改脚本，自动从 `/api/plugin-flows` 发现全部 runtime，任意新插件都能被自动纳入测试与断言。

## 何时使用

- 插件或 runtime 改动后，验证全链路行为依然符合 `PLUGIN.md` 声明
- 调整 `maxSteps`、`trigger`、`stage`、`cooldownTurns` 等触发规则后复现实际调度
- 调试 LLM 工具循环（`generate-guide`、`upsert-npc-graph`、`list-characters` 等）的耗时与输出
- 在本地用 `llmock` 或远端 e2e slot 跑成本可控的回归测试
- 只排查单个插件时用 `--plugin` / `--runtime` 聚焦

## 前置条件

1. **API server 已启动**（`pnpm dev:pg` 或 `pnpm dev:server`），默认监听 `http://localhost:3001`
2. **llm.toml 中存在目标 slot**。脚本默认使用 `e2e` slot；本地用 llmock 时常用 `e2e_local`
3. **`.env.llm`** 含对应 provider 的 API key（或 `llmock` 本地 base URL）
4. 可选：`npx llmock -p 4012 --record --provider-openai https://your-provider` 起一个本地录制代理

## 基本调用

```bash
npx tsx --env-file=.env --env-file=.env.llm \
  scripts/e2e-plugin-verify.ts [options]
```

**最常用的三个场景：**

```bash
# 1. 默认 3 turn 全流程跑一遍（用 e2e slot）
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts

# 2. 本地 llmock + e2e_local slot，5 turn
npx tsx --env-file=.env --env-file=.env.llm \
  scripts/e2e-plugin-verify.ts --slot e2e_local --turns 5 --timeout 300

# 3. 只聚焦 guide 这一个插件的表现
npx tsx --env-file=.env --env-file=.env.llm \
  scripts/e2e-plugin-verify.ts --plugin guide --turns 2
```

## 命令行参数

| 参数                     | 默认                          | 说明                                                                                      |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `--server <url>`         | `http://localhost:3001/api`   | API base URL                                                                              |
| `--slot <name>`          | `e2e`（或 `$E2E_MODEL_SLOT`） | 故事 runtime 使用的模型 slot。**只写 `[covel.xxx]` 中的 xxx 部分**，不是 `covel.xxx` 全名 |
| `--world <id>`           | `/api/worlds` 返回的第一个    | 使用的世界包 id                                                                           |
| `--turns <n>`            | `3`                           | 角色创建之后的 playing 轮数                                                               |
| `--runtime <id>`         | —                             | 只聚焦某一个 runtime，其它依然会执行但不计入断言                                          |
| `--plugin <id>`          | —                             | 只聚焦某一个 plugin                                                                       |
| `--player-message <str>` | 内置话术循环                  | 每轮玩家输入文本                                                                          |
| `--form-values <json>`   | 字段类型推断                  | 角色创建表单的默认填充值                                                                  |
| `--timeout <seconds>`    | `300`                         | 每轮 SSE 超时                                                                             |
| `--log-dir <path>`       | `debugs/e2e-logs`             | artefact 输出目录                                                                         |
| `--no-log`               | —                             | 关闭日志落盘                                                                              |
| `--verbose`              | —                             | 打印每个 SSE 事件                                                                         |
| `--keep`                 | 失败才保留                    | 通过也保留会话以便检查                                                                    |
| `--help` / `-h`          | —                             | 打印内置帮助                                                                              |

> `--plugin` / `--runtime` 是**观测+断言过滤器**，不是禁用开关：其它 runtime 仍会运行，保证 `input.inject` 依赖链完整。

## 执行流程（7 Phase）

脚本把一次运行拆成 7 个阶段，每个 Phase 都会写出小节标题和带固定列宽的表格：

| #   | Phase                      | 做了什么                                                                                                                                      |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Health Check**           | `GET /api/health`，确认 store backend 在线                                                                                                    |
| 2   | **Plugin Flow Discovery**  | `GET /api/plugin-flows`，自动发现所有 plugin/runtime 及其 trigger 元数据                                                                      |
| 3   | **World Selection**        | 挑选 `--world` 或第一个可用世界包                                                                                                             |
| 4   | **Session Creation**       | `POST /api/sessions` 建新会话，激活所有可用插件                                                                                               |
| 5   | **Turn Execution**         | 按 `setup → character_creation → playing×N` 顺序触发每一轮，逐轮对照 stage 调度期望                                                           |
| 6   | **Final Session Snapshot** | `GET /api/sessions/:id/snapshot`（+ `GET /api/sessions/:id` 取权威 status）；断言 setup 运行时的 `preGameCompleted` 完成；校验 trace 类型覆盖 |
| 7   | **Summary**                | 汇总 runtime/tool/assertion 成败 + scheduled 运行时的「≥1 次」断言，计算 `PASS`/`FAIL` 总结果                                                 |

### Phase 5 每轮产出

对于每一轮 turn，脚本都会打印四块信息：

1. **Runtime Timeline** — 按 `(stage, name)` 排序的 runtime 列表，含 `stage`、`runtime`、`status`、`dur`、`output` 摘要
2. **Tool Calls** — 所有工具调用（runtime、tool、status、dur、approval、output 前 40 字符）
3. **Trigger Verification** — 对每个已声明的 runtime 按 stage 调度语义比对「期望 vs 实际」，结果列见下表
4. **Detected interaction form**（仅首次）— 自动识别角色创建表单并填入默认值或 `--form-values` 提供的值，然后通过 `POST /api/sessions/:id/plugin-rpc` 的 `framework.submit-form` action 提交

Trigger Verification 的裁决列：

| 裁决   | 含义                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- |
| `PASS` | 期望触发（auto/setup）且成功运行                                                                         |
| `FAIL` | in-band `auto` 运行时未触发，或任一期望运行时以 `failed` 状态运行                                        |
| `WAIT` | scheduled 运行时本轮空转（interval/cooldown 可能门控），或 setup 未落 `preGameCompleted`（Phase 6 裁决） |
| `SKIP` | 本轮不期望（未激活 / 无 stage / 越 band / 已到达但 `skipped` 空转）                                      |
| `FIRE` | 无 stage 的 event/manual 运行时触发了（仅信息）                                                          |
| `WARN` | 未激活 / 越 band 的运行时意外运行了（软异常，不判 FAIL）                                                 |

## 自动发现 & 触发断言

脚本**不硬编码任何插件 id**。每次运行：

1. `GET /api/plugin-flows` 拿到全部 runtime 元数据（含 `stage` / `segmentId` / `trigger`）
2. 创建会话后从 API **读回该会话真实的 `activePlugins`**（世界种子集，通常远小于全局插件池），逐轮刷新
3. 按下面的 stage 调度语义推导每个 runtime 的期望，Turn 执行后对比实际 `runtimeResults`

**期望推导规则（复刻 stage 调度器）——三道闸门依次判定：**

1. **激活集**：`pluginId` 不在会话 `activePlugins` 里 → 永不调度（`SKIP`）。互斥 provider（如 `narrator` vs `chat-mode-narrator`、多家 image 引擎）在这一步天然收敛——只期望激活的那一个。
2. **stage**：无 `stage` 的 runtime（event / manual / 仅贡献型，如 `memory` / `director` / `cost-gate`——它们 `trigger.type` 可能是 `auto` 但没有 stage）**永不进入 stage 调度**，与 trigger.type 无关（`SKIP`；若因自身 event/manual 触发而运行则记 `FIRE`）。
3. **band**：`setup` stage 只在开场阶段跑；其余 stage（`pre-turn` / `narrative` / `post-turn` / `audit`）只在 playing 回合跑。越 band → `SKIP`。

命中三道闸门后，in-band 的触发语义**保持宽松，不复刻调度器**：

- `auto`：每个 in-band 回合都期望触发（严格 `PASS`/`FAIL`）。
- `scheduled`：只断言在整个窗口内**至少触发 1 次**（`interval` / `cooldownTurns` / `startTurn` / `maxTriggerCount` **不再逐轮复刻**）；本轮空转记 `WAIT`，run 级的「≥1 次」断言在 Phase 7 兜底。
- `setup` stage：完成信号取自会话的 `preGameCompleted`（由 `setupRuntimes` mirror 派生的 runtimeId 列表），在 Phase 6 权威裁决——因为 setup 工作可能落在 `submit-form` 子执行里，逐轮 timeline 未必看得到。
- `skipped` 状态**不是失败**：表示调度器已到达但运行时 guard/空转，计入「已触发」。只有 `failed` 才判 FAIL。

这意味着：**新增插件只要声明 PLUGIN.md frontmatter 完整、并被会话激活，就会自动进入测试矩阵**，不需要改脚本。

## 网络健壮性

真实 LLM 链路的 SSE 容易被上游连接池回收，脚本做了三层防护：

| 问题                                    | 处理                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SSE 流中途 `terminated`                 | `httpPostSse` 捕获后 soft-return `SsePostOutcome { terminated: true }`，不抛错                                                          |
| 后续 `httpGet` 因 undici 连接池污染失败 | `httpGet` 对 `fetch failed` / `ECONNRESET` / `UND_ERR_SOCKET` / `terminated` 自动重试 3 次，并在 SSE 终止后强制等 1500ms 让 socket 回收 |
| 任何 fatal 错误                         | `main()` 用 `try/finally` 包装 `MainState`，即使中途抛异常也会把已有 artefact 落盘                                                      |

## 输出与日志

每次运行默认在 `debugs/e2e-logs/` 下写入四个文件（时间戳前缀 `e2e-YYYYMMDD-HHMMSS`）：

| 文件                               | 内容                                                |
| ---------------------------------- | --------------------------------------------------- |
| `e2e-<ts>.log`                     | stdout 完整镜像（与终端输出一致）                   |
| `e2e-<ts>-<session>-turns.json`    | 所有 turn 的 runtime + tool-call + trigger 原始数据 |
| `e2e-<ts>-<session>-snapshot.json` | Phase 6 的 session snapshot                         |
| `e2e-<ts>-<session>-failures.json` | 只包含 FAIL 的断言细节（无失败则不写）              |
| `e2e-<ts>-<session>-fatal.json`    | 出现未捕获异常时的错误对象                          |

> 所有输出为**纯文本，无 emoji、无 ANSI 颜色、列宽固定**，方便 diff、grep、通过 CI pipeline。

## 退出码

| 码  | 含义                                                               |
| --- | ------------------------------------------------------------------ |
| `0` | 所有断言通过                                                       |
| `1` | 至少一条断言失败（runtime 执行失败 / 触发预测不符 / 工具调用失败） |
| `2` | 基础设施失败（HTTP、超时、响应格式错误）                           |

## 常见问题

**Q: 提示 `preset not found: covel.e2e`？**
A: `--slot` 只写 `[covel.xxx]` 里的 `xxx`。如果你的 toml 里是 `[covel.e2e_local]`，传 `--slot e2e_local`，不是 `--slot covel.e2e_local`。

**Q: Turn 4 开始一直 `WARNING: SSE stream terminated prematurely`？**
A: 上游 LLM 会话被运营商断开，脚本会自动重读 turn 记录。只要 Runtime Timeline 里的 runtime 都是 `success`，可以当作正常通过。

**Q: 某个插件（如 `codex` / `scene-prompts`）全程 `SKIP`？**
A: 期望推导按会话真实的 `activePlugins` 裁决。这些插件玩家没启用（不在世界种子集里）时就应当全程 `SKIP`，原因列会写 `plugin not in session active set`——这是正确行为，不是漏跑。要测它们就在建会话时激活对应插件。

**Q: 我想只跑 `guide` 的回归？**
A: `--plugin guide --turns 2 --slot e2e_local`。其它 runtime 依然会运行保证依赖链完整，但断言统计只算 `guide` 的表现。

## 与 PLUGIN.md 声明的对齐检查

脚本最重要的用途是验证每个 runtime 的实际表现是否匹配其 `PLUGIN.md` frontmatter。典型对照表：

| PLUGIN.md 字段                              | e2e 如何验证                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `stage: setup`                              | 只在开场跑；Phase 6 断言 runtimeId 落入 `preGameCompleted`                  |
| `stage: pre-turn/narrative/post-turn/audit` | 只在 playing 回合跑；越 band 期望 `SKIP`                                    |
| `trigger.type: auto`（有 stage）            | 每个 in-band 回合都期望触发（严格 PASS/FAIL）                               |
| `trigger.type: scheduled`（有 stage）       | 窗口内至少触发 1 次（Phase 7 「≥1」断言；不逐轮复刻 interval/cooldown）     |
| 无 `stage`（event/manual/贡献型）           | 永不进入 stage 调度，期望 `SKIP`（自身 event/manual 触发时记 `FIRE`）       |
| 未被会话激活                                | 全程 `SKIP`，原因 `plugin not in session active set`                        |
| `outputKind: story`                         | Runtime Timeline 的 output 列显示 `narrative(<字符数>c)`                    |
| `outputKind: plugin`/`system`               | Runtime Timeline output 显示 `keys=[...]`                                   |
| `maxSteps: N`                               | 工具循环耗尽时 failures.json 会看到 `exhausted the tool loop after N steps` |
| `tools.builtin` / `tools.local`             | Tool Calls 表格里能观测实际调用次数和成功率                                 |
| `runtimeType: function`                     | Tool Calls 表为空（function runtime 不跑 LLM）                              |

## 扩展建议

如果需要在 CI 跑：

1. 用 `llmock` 录制一遍真实响应，落到 `debugs/llm-cache/`
2. 后续跑 `COVEL_LLM_REPLAY=replay` 确保只读缓存
3. 退出码 `0` 即通过
