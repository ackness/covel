# E2E Plugin Verification 脚本

`scripts/e2e-plugin-verify.ts` 是 Covel 的插件级端到端测试工具。它**完全通过 HTTP API 驱动**整个游戏流水线（不需要点前端），逐轮观测每个 runtime 的执行状态、工具调用和触发行为，并把日志和 artefact 持久化到 `debugs/e2e-logs/` 下。

> 设计目标：热加载插件后不需要改脚本，自动从 `/api/plugin-flows` 发现全部 runtime，任意新插件都能被自动纳入测试与断言。

## 何时使用

- 插件或 runtime 改动后，验证全链路行为依然符合 `PLUGIN.md` 声明
- 调整 `maxSteps`、`trigger`、`stage`、`cooldownTurns` 等触发规则后复现实际调度
- 调试 LLM 工具循环（`generate-guide`、`upsert-npc-graph`、`list-characters` 等）的耗时与输出
- 按实际配置跑一遍真实模型；或用 `--slot` 把故事 runtime 切到低成本 slot 做回归
- 同一个脚本会话要反复跑时，录一遍模型应答，之后从录制回放（见[录制与回放](#录制与回放)）
- 只排查单个插件时用 `--plugin` / `--runtime` 聚焦

## 前置条件

1. **API server 已启动**（`pnpm dev:pg` 或 `pnpm dev:server`），默认监听 `http://localhost:3001`
2. **llm.toml 配置可用**。脚本默认不覆盖模型：每个 runtime 按服务端配置路由（与玩家实际游玩一致），Phase 6 列出各 runtime 实际调用的 slot / provider / model。需要时用 `--slot` 只覆盖故事 runtime
3. **server 拿得到对应 provider 的 API key**：写在 `.env.llm`，或直接设为 server 进程的环境变量（`{PROVIDER}_API_KEY`）。脚本本身不读 key；`.env` / `.env.llm` 不存在时照常运行

最小可执行流程如下（脚本本身不会启动 server，也不会自动创建 `llm.toml`）：

```bash
cp .env.example .env
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
pnpm dev:server
# 另开终端
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/e2e-plugin-verify.ts
```

若使用 PostgreSQL，把 server 启动替换为 `pnpm db:up` 后的 `pnpm dev:pg`。
`--slot` 必须是 `llm.toml` 中 `[covel.<name>]` 的 `<name>`；
脚本通过 `/api/plugin-flows` 和 `/api/worlds` 自动发现 runtime/world，不需要维护插件列表。

## 基本调用

```bash
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/e2e-plugin-verify.ts [options]
```

**最常用的三个场景：**

```bash
# 1. 默认 3 turn 全流程跑一遍（按配置路由模型）
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/e2e-plugin-verify.ts

# 2. 故事 runtime 改用 utility slot，5 turn
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/e2e-plugin-verify.ts --slot utility --turns 5 --timeout 300

# 3. 只聚焦 guide 这一个插件的表现
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/e2e-plugin-verify.ts --plugin guide --turns 2

# 4. 长时间运行 / 8k 上下文验收：要求发生压缩、后续消费摘要、无失败 trace，
#    并校验 provider 上报的每次输入不超过 8192 token
npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/e2e-plugin-verify.ts --turns 20 \
  --enable-plugins memory \
  --require-compaction --require-summary-use \
  --require-tools memory-search --strict-traces \
  --max-input-tokens 8192
```

## 命令行参数

| 参数                     | 默认                               | 说明                                                                                                             |
| ------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--server <url>`         | `http://localhost:3001/api`        | API base URL                                                                                                     |
| `--slot <name>`          | 按配置路由（或 `$E2E_MODEL_SLOT`） | 覆盖故事 runtime 的模型 slot；其余 runtime 仍按配置。**只写 `[covel.xxx]` 中的 xxx 部分**，不是 `covel.xxx` 全名 |
| `--world <id>`           | `/api/worlds` 返回的第一个         | 使用的世界包 id                                                                                                  |
| `--locale <tag>`         | `zh-CN`                            | 会话的内容语言，同时决定读取哪种语言的插件提示词；配合服务端的 `COVEL_INSTRUCTION_LOCALE` 可对比中英文指令       |
| `--session-id <id>`      | 服务端分配（世界 ID 加随机后缀）   | 用这个 ID 建会话。固定的 ID 是两次运行发出相同模型请求的条件之一，见[录制与回放](#录制与回放)                    |
| `--turns <n>`            | `3`                                | 角色创建之后的 playing 轮数                                                                                      |
| `--runtime <id>`         | —                                  | 只聚焦某一个 runtime，其它依然会执行但不计入断言                                                                 |
| `--plugin <id>`          | —                                  | 只聚焦某一个 plugin                                                                                              |
| `--enable-plugins <ids>` | —                                  | 建会话后、首轮前启用逗号分隔的插件 id；用于把 memory 等可选核心插件纳入长测                                      |
| `--core-only`            | —                                  | 只用核心插件建会话，不加载世界包的预设插件包                                                                     |
| `--player-message <str>` | 内置话术循环                       | 每轮玩家输入文本                                                                                                 |
| `--form-values <json>`   | 字段类型推断                       | 角色创建表单的默认填充值                                                                                         |
| `--timeout <seconds>`    | `300`                              | 每轮 SSE 超时                                                                                                    |
| `--log-dir <path>`       | `debugs/e2e-logs`                  | artefact 输出目录                                                                                                |
| `--no-log`               | —                                  | 关闭日志落盘                                                                                                     |
| `--verbose`              | —                                  | 打印每个 SSE 事件                                                                                                |
| `--keep`                 | 失败才保留                         | 通过也保留会话以便检查                                                                                           |
| `--require-compaction`   | —                                  | 若整次运行未出现 `context.compacted` trace，则失败                                                               |
| `--require-summary-use`  | —                                  | 若压缩后没有任何 `llm.calling` prompt 包含 `<compacted_history>`，则失败                                         |
| `--require-tools <ids>`  | —                                  | 要求逗号分隔的每个工具至少出现一次成功的 `tool.completed` trace                                                  |
| `--strict-traces`        | —                                  | 遇到任意 `*.failed`、`error.occurred` 或错误 `llm.responded` trace 时失败                                        |
| `--no-language-check`    | —                                  | 跳过“模型输出是否使用会话语言”和“提示词语言”的检查                                                               |
| `--max-input-tokens <n>` | —                                  | 按 `llm.responded.payload.usage.inputTokens` 校验 provider 实际输入上限；完全缺失 usage 会失败                   |
| `--help` / `-h`          | —                                  | 打印内置帮助                                                                                                     |

> `--plugin` / `--runtime` 是**观测+断言过滤器**，不是禁用开关：其它 runtime 仍会运行，保证 `io.inputs` / `schedule.needs` 依赖链完整。`--enable-plugins` 会真实修改测试会话的激活集。

## 执行流程（7 Phase）

脚本把一次运行拆成 7 个阶段，每个 Phase 都会写出小节标题和带固定列宽的表格：

| #   | Phase                     | 做了什么                                                                                                                                                                                                         |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Health Check**          | `GET /api/health`，确认 store backend 在线                                                                                                                                                                       |
| 2   | **Plugin Flow Discovery** | `GET /api/plugin-flows`，自动发现所有 plugin/runtime 及其 trigger 元数据                                                                                                                                         |
| 3   | **World Selection**       | 挑选 `--world` 或第一个可用世界包                                                                                                                                                                                |
| 4   | **Session Creation**      | 读取 `GET /api/worlds/:id/plugin-plan`，与准备页一样按预设插件包的默认选择加上世界必需插件调用 `POST /api/sessions`（`--core-only` 时只用核心插件），按需启用 `--enable-plugins`，并读取最终真实 `activePlugins` |
| 5   | **Turn Execution**        | 按 `setup → character_creation → playing×N` 顺序触发每一轮，逐轮对照 stage 调度期望                                                                                                                              |
| 6   | **Final Session View**    | `GET /api/sessions/:id/view`（+ `GET /api/sessions/:id` 取权威 status）；断言 setup 运行时与后台作业终态；从 trace 列出各 runtime 实际调用的模型；保存完整 trace，并执行长运行严格断言                           |
| 7   | **Summary**               | 汇总 runtime/tool/assertion 成败 + scheduled 运行时的「≥1 次」断言，计算 `PASS`/`FAIL` 总结果                                                                                                                    |

### Phase 5 每轮产出

每个动作按 SSE 信封里的 `turnId` 从 `GET /api/sessions/:id/turns` 读回本次请求的执行记录（该列表也包含后台与 detached 作业各自的执行，最新一行不一定属于本次请求）。完成最后一个 setup runtime 的请求会接力开场回合，此时两条执行都会报告：先是 setup 执行，再是 playing 段的开场接力。`execution.completed.committed` 为 `false` 时该轮判 FAIL。

对于每一条执行，脚本都会打印四块信息：

1. **Runtime Timeline** — 按 `(stage, name)` 排序的 runtime 列表，含 `stage`、`runtime`、`status`、`dur`、`output` 摘要
2. **Tool Calls** — 所有工具调用（runtime、tool、status、dur、approval、output 前 40 字符）
3. **Trigger Verification** — 对每个已声明的 runtime 按 stage 调度语义比对「期望 vs 实际」，结果列见下表
4. **Detected interaction form**（setup 阶段，最多 3 个）— 从 runtime 结果的 `effects.interactions`（或 `create-form` / `create-character-form` 工具调用）识别 setup 表单（如角色创建，以及之后 `tabletop-rules` 的开局配点），填入默认值或 `--form-values` 提供的值，然后通过 `POST /api/sessions/:id/plugin-rpc` 的 `framework.submit-form` action 提交并发送一条消息推进；只要会话仍在 setup 且又出现新表单就继续处理。数字字段取 `defaultValue`（否则取 `min`），声明 `validation: { name: "point-buy" }` 的表单按 `data.budget` 把点数逐一分配到未覆盖的数字字段

Trigger Verification 的裁决列：

| 裁决    | 含义                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PASS`  | 期望触发（auto/setup）且成功运行                                                                                       |
| `DEFER` | detached 运行时随回合提交并转入后台作业（流内有 `runtime.deferred`），作业结果在 Phase 6 裁决                          |
| `FAIL`  | in-band `auto` 运行时未触发，或任一期望运行时以 `failed` 状态运行                                                      |
| `WAIT`  | scheduled 运行时本轮空转（cooldown / 触发次数可能门控），或 setup 尚未在 `setupRuntimes` 中落为 `done`（Phase 6 裁决） |
| `SKIP`  | 本轮不期望（未激活 / 无 stage / 越 band / `startTurn` 或 `interval` 不覆盖本逻辑回合 / 已到达但 `skipped` 空转）       |
| `FIRE`  | 无 stage 的 event/manual 运行时触发了（仅信息）                                                                        |
| `WARN`  | 未激活 / 越 band 的运行时意外运行了（软异常，不判 FAIL）                                                               |

## 自动发现 & 触发断言

脚本**不硬编码任何插件 id**。每次运行：

1. `GET /api/plugin-flows` 拿到全部 runtime 元数据（含 `stage` / `segmentId` / `trigger`）
2. 创建会话后从 API **读回该会话真实的 `activePlugins`**（世界种子集，通常远小于全局插件池），逐轮刷新
3. 按下面的 stage 调度语义推导每个 runtime 的期望，Turn 执行后对比实际 `runtimeResults`

**期望推导规则（复刻 stage 调度器）——三道闸门依次判定：**

1. **激活集**：`pluginId` 不在会话 `activePlugins` 里 → 永不调度（`SKIP`）。互斥 provider（如 `narrator` vs `chat-mode-narrator`、多家 image 引擎）在这一步天然收敛——只期望激活的那一个。
2. **stage**：无 `stage` 的 runtime（event / manual / 仅贡献型，如 `memory` / `history-compaction`——它们 `trigger.type` 可能是 `auto` 但没有 stage）**永不进入 stage 调度**，与 trigger.type 无关（`SKIP`；若因自身 event/manual 触发而运行则记 `FIRE`）。
3. **band**：`setup` stage 只在开场阶段跑；其余 stage（`pre-turn` / `narrative` / `post-turn` / `audit`）只在 playing 回合跑。越 band → `SKIP`。

命中三道闸门后，按执行所在的逻辑回合（`completedPlayerTurns + 1`，开场接力与第一条玩家消息同为 1）判定：

- `startTurn` 大于逻辑回合，或 `scheduled` 的 `interval` 不整除逻辑回合 → 本轮不期望（`SKIP`）。
- 不带 `cooldownTurns` / `maxTriggerCount` 的 `auto`：每个 in-band 回合都期望触发（严格 `PASS`/`FAIL`）。
- `scheduled`，以及带 `cooldownTurns` / `maxTriggerCount` 的 `auto`：只断言在允许的回合里**至少触发 1 次**（冷却与触发次数不逐轮复刻）；本轮空转记 `WAIT`，run 级的「≥1 次」断言在 Phase 7 兜底。
- `turnCompletion.mode: detached` 的运行时不出现在本回合结果里；流内的 `runtime.deferred` 算作触发（`DEFER`）。Phase 6 等待后台队列清空，要求本会话每个后台作业以 `succeeded`（或主动 `cancelled`）结束。
- `setup` stage：完成信号直接取自会话 `setupRuntimes[runtimeId].state === "done"`，在 Phase 6 权威裁决——因为 setup 工作可能落在 `submit-form` 子执行里，逐轮 timeline 未必看得到。
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

成功运行的末尾会打印 summary，并以 `PASS` 作为总结果，进程退出码为 `0`；
失败断言显示 `FAIL`（退出码 `1`），无法连接 API、SSE 超时或响应格式错误显示基础设施
错误（退出码 `2`）。默认还会在 `debugs/e2e-logs/` 生成 `.log`、turn JSON、最终 snapshot
及失败详情 JSON；传 `--no-log` 可关闭。

## 脚本判断“通过”的依据

除了每个 runtime 的状态和触发断言，Phase 6 还从 trace 里检查两件已提交结果看不到的事：

- **被拒后重试的工具调用。** 参数校验失败的调用会被模型重发，回合结果里不留记录，所以汇总里的 `fail` 一直是 0。脚本从 `tool.failed` trace 统计它们，按 runtime、工具、错误分组列出，并在汇总行显示 `rejected-and-retried=N`。每一次都多花一轮模型调用；数量多说明工具 schema 或提示词有问题。只记为 warning：真实模型每局都会有几次。只有被拒次数超过成功次数时才判 FAIL，那说明某个工具或提示词已经无法被满足；`--strict-traces` 则是一次都不允许。
- **输出语言。** 脚本读取每个 runtime 的回复正文和工具参数里的自由文本（跳过 id、路径、枚举值、locale map 的各语言槽和 `runtime-done` 的备注），判断它是否使用会话语言的文字：中日韩会话里不应出现整句英文，其他语言的会话里不应出现中日韩文字。某个 runtime 写错语言的文本达到 5 条且占其文本的一成以上时判 FAIL，零星出现记为 warning。脚本自带的角色名和玩家发言会跟随 `--locale`，避免测试输入本身把另一种语言带进上下文。
- **提示词语言。** 非中日韩语言的会话里，脚本统计发给模型的提示词和工具定义中出现的中日韩文字（同一行只计一次，按 runtime 列出并给出一处例子）。模型读到中文上下文就容易用中文作答，这一项指出中文是从哪里进来的：插件把双语标签存进了会被注入的数据、世界的语言文件漏翻，等等。它是警告而不是失败——没有该语言版本的世界本来就会带入原文。`--no-language-check` 同时跳过这一项。

## 常见问题

**Q: `ECONNREFUSED`、health check 失败或一直连接 3001？**
A: 该脚本只调用 API，不负责启动服务。确认 `pnpm dev:server` / `pnpm dev:pg` 正在运行，
并用 `--server http://localhost:<port>/api` 指定非默认端口；`SERVER_PORT` 改变时必须同步
修改该参数。

**Q: `preset not found`、`slot` 不存在或模型请求 401？**
A: `--slot` 只接受 `[covel.xxx]` 的 `xxx`，不是完整表名；例如
`[covel.e2e_local]` 应传 `--slot e2e_local`。确认 `.env.llm` 中 provider key 和
`llm.toml` 的 slot/provider 配置有效。使用录制代理时，直接把该 slot 的 `baseUrl`
改为代理地址；`COVEL_STORY_BASE_URL` / `COVEL_PLUGIN_BASE_URL` 当前没有运行时读取方。

**Q: 想保留 session、trace 或失败现场？**
A: 传 `--keep` 保留通过后的 session；默认日志和 JSON 在 `debugs/e2e-logs/`，传
`--log-dir <path>` 改目录，传 `--verbose` 输出完整 SSE 事件。

**Q: Turn 4 开始一直 `WARNING: SSE stream terminated prematurely`？**
A: 上游 LLM 会话被运营商断开，脚本会自动重读 turn 记录。只要 Runtime Timeline 里的 runtime 都是 `success`，可以当作正常通过。

**Q: 某个插件（如 `codex` / `guide`）全程 `SKIP`？**
A: 期望推导按会话真实的 `activePlugins` 裁决。这些插件玩家没启用（不在世界种子集里）时就应当全程 `SKIP`，原因列会写 `plugin not in session active set`——这是正确行为，不是漏跑。要测它们就在建会话时激活对应插件。

**Q: 我想只跑 `guide` 的回归？**
A: `--plugin guide --turns 2`。其它 runtime 依然会运行保证依赖链完整，但断言统计只算 `guide` 的表现。

## 与 PLUGIN.md 声明的对齐检查

脚本最重要的用途是验证每个 runtime 的实际表现是否匹配其 `PLUGIN.md` frontmatter。典型对照表：

| PLUGIN.md 字段                              | e2e 如何验证                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `stage: setup`                              | 只在开场跑；Phase 6 断言 `setupRuntimes[runtimeId].state === "done"`        |
| `stage: pre-turn/narrative/post-turn/audit` | 只在 playing 回合跑；越 band 期望 `SKIP`                                    |
| `trigger.type: auto`（有 stage）            | 每个 in-band 回合都期望触发（严格 PASS/FAIL）                               |
| `trigger.type: scheduled`（有 stage）       | `interval` / `startTurn` 允许的回合里至少触发 1 次（Phase 7 「≥1」断言）    |
| `turnCompletion.mode: detached`             | 回合内记 `DEFER`；Phase 6 断言对应后台作业 `succeeded`                      |
| 无 `stage`（event/manual/贡献型）           | 永不进入 stage 调度，期望 `SKIP`（自身 event/manual 触发时记 `FIRE`）       |
| 未被会话激活                                | 全程 `SKIP`，原因 `plugin not in session active set`                        |
| `outputKind: story`                         | Runtime Timeline 的 output 列显示 `narrative(<字符数>c)`                    |
| `outputKind: plugin`/`system`               | Runtime Timeline output 显示 `keys=[...]`                                   |
| `maxSteps: N`                               | 工具循环耗尽时 failures.json 会看到 `exhausted the tool loop after N steps` |
| `tools.builtin` / `tools.plugin`            | Tool Calls 表格里能观测实际调用次数和成功率                                 |
| `runtimeType: function`                     | Tool Calls 表为空（function runtime 不跑 LLM）                              |

## 录制与回放

一局脚本会话的时间几乎都花在等模型上。`pnpm llm:replay` 在模型端点前面放一个代理（基于 `@copilotkit/aimock`）：第一遍把每个请求的应答录下来，之后同样的请求直接从录制里应答，不再调用模型。`lantern-barrow` 三回合会话有 47 次模型调用，录制用了 229 秒，回放 47 次全部命中，用了 4 秒。

回放要求两遍会话发出**完全相同**的请求。一条请求不同，模型就会写出新内容，后面的请求全部跟着变。所以每一遍都要满足：

1. **固定会话 ID**：`--session-id <id>`。会话 ID 会出现在提示词里。
2. **服务端设置 `COVEL_RANDOM_SEED`**：插件从 `ctx.random` 取的骰子和 ID 里的随机部分每遍相同。插件直接用 `node:crypto` 或 `Math.random` 取的数不受它控制。
3. **每遍开始时这个会话 ID 不存在**：同一个 ID 不能建两次。最简单的做法是每遍用一个新的数据库文件。脚本通过后会删除会话，所以也可以在同一个服务端上接着跑下一遍；失败或带 `--keep` 时会话保留，要先删除。
4. **世界、插件、提示词、语言和模型配置都没有变**。改了其中任何一项，受影响的请求就是新请求，这正是需要重新录制的时候。

### 录进仓库：`pnpm e2e:replay`

`tests/llm-replay/` 下每个目录是一局录好的会话，录制随仓库提交，换一台机器检出后不需要模型、密钥和网络就能回放：

```bash
pnpm e2e:replay                  # 回放全部
pnpm e2e:replay lantern-barrow   # 只回放一局
```

一个目录里有三样东西：

| 文件            | 内容                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `scenario.json` | 脚本会话：`world`、`turns`、`locale`（默认 `zh-CN`）、`sessionId`、`seed`，以及传给脚本的其余参数 `args` |
| `llm.toml`      | 录制时用的模型。每个 `[covel.<slot>]` 都要写 `provider` 和 `baseUrl`；`baseUrl` 运行时换成代理地址       |
| `recording/`    | 每条请求一个应答文件，文件名是请求摘要的前 16 位                                                         |

每局会话命令依次启动代理、一个专用服务端和脚本会话，结束后全部停掉。专用服务端用临时目录里的新 SQLite 数据库和自己的 `COVEL_HOME`，设置会话的 `COVEL_RANDOM_SEED` 和 `TZ=UTC`；不读 `.env`、`~/.covel`，也不继承 shell 里的 `COVEL_*`、`E2E_*`、`STORE_BACKEND` 等变量和各家密钥，所以两台机器上的会话发出同样的请求。回放时每条请求都要在录制里，有一条不在就判失败；脚本断言失败同样判失败。脚本日志、服务端日志和用来匹配的请求写在 `debugs/llm-replay/<会话>/`。`--verbose` 实时打印脚本输出。

**录制或重录**。改了世界、插件、提示词或 `llm.toml` 之后：

```bash
pnpm e2e:replay --record --upstream https://api.deepseek.com lantern-barrow
```

`--upstream` 是 `llm.toml` 里那家服务商的 origin，不带 `/v1`。密钥按 `llm.toml` 的 provider 取名（`deepseek` → `DEEPSEEK_API_KEY`），从环境变量或仓库根目录的 `.env.llm` 读取。录制里已有的请求直接应答，只有新请求转给上游，所以只改了一个插件的提示词时，重录只调用受影响的那部分。会话跑完（脚本以 `0` 或 `1` 退出）后，这次没有用到的旧应答从 `recording/` 删除；中途出错的会话不删。确认结果后把 `recording/` 的变动一起提交。录制文件里是模型应答原文，不含密钥，也不含提示词和流式时序，体积用 `du -sh tests/llm-replay/<会话>/recording` 查看；`.gitattributes` 把它们标为生成文件，PR 里默认折叠。提示词在 `debugs/` 下的 `*.requests` 里，每条请求都是完整的上下文，比应答大得多，不进版本库。

新增一局会话：复制一个目录，改 `scenario.json`，删掉 `recording/`，再录制一遍。

### 手动录制与回放

不放进仓库、只在本机反复跑一局会话时，可以分别启动代理、服务端和脚本。准备一份把会用到的 slot 都指到代理的模型配置，例如 `debugs/llm-replay/llm.toml`（`debugs/` 不进版本库）。下面以一个监听 `127.0.0.1:3425` 的 OpenAI 兼容端点为例，provider 名和模型换成自己的：

```toml
[covel.story]
provider = "local"
model    = "codex/gpt-6-luna"
baseUrl  = "http://127.0.0.1:4012/v1"
protocol = "openai-chat-v1"

[covel.plugin]
provider = "local"
model    = "codex/gpt-6-luna"
baseUrl  = "http://127.0.0.1:4012/v1"
protocol = "openai-chat-v1"
```

**录制**。三个终端依次启动代理、服务端和脚本会话。`--upstream` 是真实端点的 origin，不带 `/v1`。密钥仍由服务端按 provider 发送（这里是 `LOCAL_API_KEY`），代理原样转给上游：

```bash
pnpm llm:replay --mode record --fixtures debugs/llm-replay/demo --upstream http://127.0.0.1:3425
```

```bash
SERVER_PORT=3160 COVEL_RANDOM_SEED=20261006 \
  COVEL_LLM_TOML="$PWD/debugs/llm-replay/llm.toml" \
  SQLITE_PATH="$PWD/debugs/llm-replay/run-a/covel.db" \
  COVEL_LOGS_DIR="$PWD/debugs/llm-replay/run-a/logs" \
  LOCAL_API_KEY=your-key \
  pnpm --filter @covel/server exec tsx src/index.ts
```

```bash
pnpm exec tsx scripts/e2e-plugin-verify.ts --server http://localhost:3160/api \
  --world lantern-barrow --turns 3 --session-id lantern-barrow-replay
```

会话结束后停掉服务端，再用 Ctrl-C 停掉代理。代理退出时打印统计，并写出 `debugs/llm-replay/demo.record.stats.json` 和 `debugs/llm-replay/demo.record.requests/`（每条请求用来匹配的内容）。

**回放**。代理换成 `--mode replay`，服务端换一个新的数据库文件，脚本命令不变：

```bash
pnpm llm:replay --mode replay --fixtures debugs/llm-replay/demo
```

```bash
SERVER_PORT=3160 COVEL_RANDOM_SEED=20261006 \
  COVEL_LLM_TOML="$PWD/debugs/llm-replay/llm.toml" \
  SQLITE_PATH="$PWD/debugs/llm-replay/run-b/covel.db" \
  COVEL_LOGS_DIR="$PWD/debugs/llm-replay/run-b/logs" \
  LOCAL_API_KEY=your-key \
  pnpm --filter @covel/server exec tsx src/index.ts
```

```bash
pnpm exec tsx scripts/e2e-plugin-verify.ts --server http://localhost:3160/api \
  --world lantern-barrow --turns 3 --session-id lantern-barrow-replay
```

统计里 `served` 的 `none 200` 是从录制应答的请求数，`proxy 200` 是转给上游的请求数。回放模式没有上游：没录过的请求得到错误，对应的 runtime 失败。

### 没有全部命中时

```bash
pnpm llm:replay:diff debugs/llm-replay/demo.record.requests debugs/llm-replay/demo.replay.requests
```

它列出第二遍里第一遍没有的请求，以及每条请求从哪里开始与第一遍最接近的请求不同。先看序号最小的那条：后面的多半是它引起的。要让没命中的请求也有应答可看，第二遍也用 `--mode record`（同样带 `--upstream`）并加 `--tag <名字>`，没录过的请求会转给上游并补录。

`pnpm e2e:replay` 的两遍请求在 `debugs/llm-replay/<会话>/record.requests` 和 `replay.requests`。录制那一遍若是在另一台机器上做的，本机没有 `record.requests`：先在本机录一遍，再回放比较。

### 代理怎样匹配请求

- 匹配键是整条请求的摘要。aimock 自带的键只看最后一条用户消息、模型名、assistant 消息数和有没有工具结果；Covel 里叙事之后的各个 agent 最后一条用户消息相同，用它会互相串。
- 工具调用 ID 不进入匹配键。UUID、时间戳（包括被长度上限截断的）和未固定的会话 ID 也不进入，这是一层保险：内核写进提示词的记录已经不带这些值（见 [插件参考](../reference/plugins.md#输入和输出)），上面那局会话的两遍请求在替换之前就逐字相同。插件自己拼进提示词的值如果带着它们，匹配仍然不受影响。
- 流式应答连同时序一起录制。回放默认把录下的延迟除以 1000；`--speed 1` 按录制时的节奏回放（同样规模的一份录制是 37 秒）。
- 重启后的代理会加载已有的录制，录制模式下也是这样。
- 录制时上游在 200 的流里返回过错误的请求，回放时仍得到一个错误，服务端因此走和录制时相同的重试路径。aimock 把这种应答录成没有内容也没有用量的回复，代理按这个特征识别它。

### 已知范围

- 只在 `lantern-barrow` 三回合会话上验证过整局回放。更长的会话、别的世界可能还有没处理的差异来源，用 `pnpm llm:replay:diff` 定位。
- 换机器带来的差异（仓库路径、`HOME`、时区、`LANG`、shell 里的 `COVEL_*` 和 `E2E_MODEL_SLOT`）只在一局停在创角的会话上验证过：用假模型录制 8 条请求，在另一个路径的仓库副本里回放全部命中。
- 回放时模型应答从几秒变成几毫秒。提示词如果依赖后台作业与下一回合的先后，两遍可能不同；上面的会话里没有出现。
- 仓库的 CI 不运行 `pnpm e2e:replay`。它不需要密钥和网络，可以作为一个 job 放进 CI；代价是改了提示词、插件或世界的提交要带上重录的 `recording/`，否则这个 job 失败。
