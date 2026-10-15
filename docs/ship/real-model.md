# 用真实模型验证

这一页讲怎样用一条命令，在一个运行中的 Covel 服务端上自动玩几个回合，并检查每个插件有没有按它的配置运行。命令是 `pnpm e2e:verify`。它不打开浏览器，全程通过服务端接口进行。读完之后，你能跑通它、读懂它的报告，并且知道怎样把一局录下来反复回放。

它适合这些时候：

- 改了插件或 runtime，想确认整条流程仍然正常。
- 改了触发方式、阶段、间隔这些规则，想看实际是怎样调度的。
- 想看模型调用工具用了多久、输出了什么。
- 准备发布，要在真实模型上跑一遍。

先做完[测试插件](./test.md)里的校验和离线运行。那两步不花钱；这一步会调用真实模型。

## 开始之前

1. 服务端已经启动：`pnpm dev:server`，或者用 PostgreSQL 时先 `pnpm db:up` 再 `pnpm dev:pg`。默认地址是 `http://localhost:3001`。
2. 模型配置可用。脚本默认不改模型：每个 runtime 用服务端配置给它的模型，和玩家实际玩的时候一样。
3. 服务端拿得到模型服务商的密钥：写在 `.env.llm` 里，或者设成服务端进程的环境变量。脚本自己不读密钥。

第一次在仓库里运行时：

```bash
cp .env.example .env
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
pnpm dev:server
```

然后另开一个终端运行脚本。脚本不会替你启动服务端，也不会创建 `llm.toml`。

> [!NOTE]
> 脚本不处理“授权插件操作”。它适合验证仓库 `plugins/` 下的内置插件。用户插件目录里的社区插件需要授权才能运行，请按[打包并试装](./package.md)在游戏里验证。

## 1. 跑一遍

```bash
pnpm e2e:verify
```

默认玩 3 个回合，用服务端返回的第一个世界。脚本依次做七件事，每一步都打印一个标题和一张表：

| 步骤 | 名称                  | 做什么                                                                      |
| ---- | --------------------- | --------------------------------------------------------------------------- |
| 1    | Health Check          | 确认服务端在线                                                              |
| 2    | Plugin Flow Discovery | 向服务端要全部插件和 runtime 的清单                                         |
| 3    | World Selection       | 选定世界                                                                    |
| 4    | Session Creation      | 像准备页一样建一局游戏，并读回这一局实际启用了哪些插件                      |
| 5    | Turn Execution        | 依次进行开局、创建角色、然后是 N 个回合，每回合对照期望                     |
| 6    | Final Session View    | 检查开局步骤和后台任务都已结束，列出每个 runtime 实际用的模型，保存调试记录 |
| 7    | Summary               | 汇总，给出 `PASS` 或 `FAIL`                                                 |

脚本里没有写死任何插件的名字。它从服务端读插件清单，所以新插件只要配置完整、并且在这一局里被启用，就会自动进入检查。

结束时看最后的总结和退出码：

| 退出码 | 意思                                                             |
| ------ | ---------------------------------------------------------------- |
| `0`    | 全部检查通过，总结是 `PASS`                                      |
| `1`    | 至少一项检查失败：runtime 运行失败、没有按期望触发、工具调用失败 |
| `2`    | 环境问题：连不上服务端、超时、响应格式不对                       |

## 2. 只看一个插件

```bash
pnpm e2e:verify --plugin guide --turns 2
```

`--plugin` 和 `--runtime` 只是过滤报告和检查的范围。别的 runtime 仍然照常运行，这样依赖关系才是完整的。

要测的插件不在这个世界默认启用的插件里时，用 `--enable-plugins` 把它加进这一局：

```bash
pnpm e2e:verify --enable-plugins memory --plugin memory
```

## 3. 读每个回合的报告

每一次执行，脚本打印四块内容：

| 块                        | 内容                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| Runtime Timeline          | 这次执行里运行过的 runtime：阶段、名字、状态、耗时、输出摘要               |
| Tool Calls                | 每一次工具调用：哪个 runtime、哪个工具、状态、耗时、是否经过授权、输出开头 |
| Trigger Verification      | 对每个 runtime 比较“应该运行吗”和“实际运行了吗”                            |
| Detected interaction form | 开局阶段出现的表单，以及脚本怎样填写它                                     |

完成最后一个开局步骤的那次请求会接着进行开场回合，所以这时会报告两次执行：先是开局，再是开场。

回合没有保存成功（`execution.completed.committed` 是 `false`）时，这一回合判为 `FAIL`。

### 触发检查的结果

| 结果    | 意思                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| `PASS`  | 应该运行，并且成功运行了                                                                       |
| `DEFER` | 这是一个后台 runtime。回合已经结束，它转到后台继续，结果在第 6 步检查                          |
| `FAIL`  | 每回合都该运行的 runtime 没有运行，或者某个该运行的 runtime 失败了                             |
| `WAIT`  | 按间隔运行的 runtime 这一回合没轮到；或者开局步骤还没有被记为完成（第 6 步再检查）             |
| `SKIP`  | 这一回合本来就不该运行：插件没启用、不属于这个阶段、还没到开始的回合，或者运行了但自己决定跳过 |
| `FIRE`  | 由事件或手动触发的 runtime 运行了。只是告知                                                    |
| `WARN`  | 一个不该运行的 runtime 运行了。不算失败，但值得看一眼                                          |

状态是 `skipped` 的 runtime **不算失败**：它被调度到了，只是自己的 guard 决定这次不做事。只有 `failed` 才判 `FAIL`。

### 脚本怎样决定“应该运行吗”

它按服务端调度的规则推算。先过三道关，任何一道不过就是 `SKIP`：

1. **启用**：插件在这一局启用的插件里吗？不在就永远不运行。原因一栏会写 `plugin not in session active set`。互相替代的插件（两个叙事插件、几家图片引擎）只有被启用的那一个会被期望运行。
2. **阶段**：runtime 声明了 `stage` 吗？没有声明的（由事件或手动触发的，或者只贡献内容的）不参与按阶段的调度。它自己被触发时记为 `FIRE`。
3. **时段**：`setup` 阶段的只在开局运行；其余阶段的只在正式回合运行。

过了三道关之后，再看这是第几个回合（开场和玩家的第一条消息都算第 1 回合）：

| 配置                                                       | 期望                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `startTurn` 比当前回合大，或者 `every` 不整除当前回合      | 这一回合不运行（`SKIP`）                                                                                  |
| `auto`，没有 `every`、冷却和次数上限                       | 每个回合都必须运行（严格的 `PASS` / `FAIL`）                                                              |
| 带 `every`、`cooldownTurns` 或 `maxTriggerCount` 的 `auto` | 整局里至少运行 1 次。没轮到的回合记 `WAIT`，第 7 步统一检查                                               |
| `schedule.detached: true`                                  | 回合里记 `DEFER`。第 6 步等后台任务清空，要求每个任务成功或被主动取消                                     |
| `stage: setup`                                             | 第 6 步检查这一局的记录里它是不是已完成。开局的工作可能发生在表单提交之后，所以逐回合的报告里不一定看得到 |

### 脚本怎样填表单

开局阶段出现表单时（创建角色、分配点数），脚本自动填写并提交，最多处理 3 张：

- 数字字段用它的默认值，没有默认值就用最小值。
- 配点表单按预算把点数逐一分到数字字段上。
- 想指定值时用 `--form-values '<json>'`。

## 4. 两项只有调试记录里才看得到的检查

第 6 步还从调试记录里检查两件事。它们在已保存的回合结果里看不出来。

**被拒绝后重试的工具调用。**模型传错参数时，调用被拒绝，模型会重新调用一次。回合结果里不留痕迹，所以总结里的 `fail` 一直是 0。脚本把这些调用按 runtime、工具和错误分组列出来，并在总结行里显示 `rejected-and-retried=N`。

- 每一次都多花一轮模型调用。数量多，说明工具的参数定义或提示词有问题。
- 它只算警告：真实模型每局都会有几次。
- 被拒绝的次数超过成功的次数时才判 `FAIL`。
- 加 `--strict-traces` 之后，一次都不允许。

**语言。**

- 输出语言：脚本读每个 runtime 的回复和工具参数里的自由文本，判断它是不是用了这一局游戏的语言。中日韩语言的游戏里不该出现整句英文，其他语言的游戏里不该出现中日韩文字。一个 runtime 写错语言的文本达到 5 条、并且占它全部文本的一成以上时判 `FAIL`；零星几条只算警告。
- 提示词语言：在非中日韩语言的游戏里，脚本统计发给模型的提示词和工具定义中出现的中日韩文字，按 runtime 列出并各给一个例子。模型读到中文就容易用中文回答，这一项指出中文是从哪里进来的。它只是警告。

`--no-language-check` 同时跳过这两项。脚本自带的角色名和玩家发言会跟随 `--locale`，不会把另一种语言带进来。

## 5. 看日志

每次运行默认在 `debugs/e2e-logs/` 下写几个文件，文件名以 `e2e-<日期>-<时间>` 开头：

| 文件                               | 内容                                             |
| ---------------------------------- | ------------------------------------------------ |
| `e2e-<ts>.log`                     | 终端输出的完整副本                               |
| `e2e-<ts>-<session>-turns.json`    | 每个回合的 runtime、工具调用和触发检查的原始数据 |
| `e2e-<ts>-<session>-snapshot.json` | 第 6 步读到的这一局的状态                        |
| `e2e-<ts>-<session>-traces.json`   | 这一局的完整调试记录                             |
| `e2e-<ts>-<session>-failures.json` | 失败的检查的细节。没有失败就不写                 |
| `e2e-<ts>-<session>-fatal.json`    | 出现意外错误时的错误信息                         |

输出是纯文本：没有 emoji，没有颜色，列宽固定，方便比较和搜索。即使中途出错，已经得到的内容也会写下来。

通过之后，脚本会删除这一局游戏。想留着它检查，加 `--keep`。失败时总是保留。

## 全部参数

```bash
pnpm e2e:verify [options]
```

| 参数                     | 默认                                | 说明                                                                                  |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `--server <url>`         | `http://localhost:3001/api`         | 服务端接口的地址                                                                      |
| `--slot <name>`          | 不改（或环境变量 `E2E_MODEL_SLOT`） | 让写故事的 runtime 改用这个模型用途，其余 runtime 不变。只写 `[covel.xxx]` 里的 `xxx` |
| `--world <id>`           | 服务端返回的第一个世界              | 用哪个世界                                                                            |
| `--locale <tag>`         | `zh-CN`                             | 这一局游戏的语言。它也决定读哪种语言的提示词                                          |
| `--session-id <id>`      | 服务端分配                          | 用这个 ID 建游戏。回放时需要固定它，见[录制与回放](#录制与回放)                       |
| `--turns <n>`            | `3`                                 | 创建角色之后玩几个回合                                                                |
| `--runtime <id>`         | 无                                  | 报告和检查只看这一个 runtime                                                          |
| `--plugin <id>`          | 无                                  | 报告和检查只看这一个插件                                                              |
| `--enable-plugins <ids>` | 无                                  | 建好游戏后、第一个回合前，启用这些插件。用逗号分隔                                    |
| `--core-only`            | 无                                  | 只用核心插件建游戏，不加载世界预设的插件                                              |
| `--player-message <str>` | 内置的几句话轮流用                  | 每个回合的玩家输入                                                                    |
| `--form-values <json>`   | 按字段类型推断                      | 填表单时用的值                                                                        |
| `--timeout <seconds>`    | `300`                               | 每个回合最多等多久                                                                    |
| `--log-dir <path>`       | `debugs/e2e-logs`                   | 日志写到哪里                                                                          |
| `--no-log`               | 无                                  | 不写日志文件                                                                          |
| `--verbose`              | 无                                  | 打印收到的每一个事件                                                                  |
| `--keep`                 | 失败时才保留                        | 通过之后也保留这一局游戏                                                              |
| `--require-compaction`   | 无                                  | 整次运行里没有发生过历史压缩就失败                                                    |
| `--require-summary-use`  | 无                                  | 压缩之后，没有任何一次模型调用的提示词里带着 `<compacted_history>` 就失败             |
| `--require-tools <ids>`  | 无                                  | 列出的每个工具都至少成功调用过一次，否则失败                                          |
| `--strict-traces`        | 无                                  | 调试记录里有任何失败或出错的模型回复就失败                                            |
| `--no-language-check`    | 无                                  | 跳过语言检查                                                                          |
| `--max-input-tokens <n>` | 无                                  | 检查服务商报告的每次输入都不超过这个数。完全没有用量数据也算失败                      |
| `--help` / `-h`          | 无                                  | 打印帮助                                                                              |

几个常用的组合：

```bash
# Story runtimes on the utility slot, five turns
pnpm e2e:verify --slot utility --turns 5 --timeout 300

# Long run with a small context: compaction must happen and be used
pnpm e2e:verify --turns 20 \
  --enable-plugins memory \
  --require-compaction --require-summary-use \
  --require-tools memory-search --strict-traces \
  --max-input-tokens 8192
```

想对比中文和英文的提示词，用 `--locale` 配合服务端的环境变量 `COVEL_INSTRUCTION_LOCALE`。

## 配置和实际表现怎样对上

这个脚本最大的用处，是确认每个 runtime 的实际表现符合它的配置：

| 配置                                                    | 脚本怎样验证                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `schedule.stage: setup`                                 | 只在开局运行。第 6 步检查它被记为完成                            |
| `stage: pre-turn` / `narrative` / `post-turn` / `audit` | 只在正式回合运行                                                 |
| `auto`（默认），有 `stage`                              | 每个回合都必须运行                                               |
| `auto`，有 `stage` 和 `every`                           | 在允许的回合里至少运行 1 次                                      |
| `schedule.detached: true`                               | 回合里记 `DEFER`，第 6 步检查后台任务成功                        |
| 没有 `stage`                                            | 不按阶段调度。自己被触发时记 `FIRE`                              |
| 插件没有在这一局启用                                    | 全程 `SKIP`                                                      |
| `io.visibility: story`                                  | Runtime Timeline 的输出一栏显示 `narrative(<字符数>c)`           |
| `io.visibility: system`（默认）                         | 输出一栏显示 `keys=[...]`                                        |
| `agent.loop.maxSteps: N`                                | 步数用完时，失败记录里有 `exhausted the tool loop after N steps` |
| `agent.tools`、`contributes.tools`                      | Tool Calls 表里能看到实际的调用次数和成功率                      |
| 有 `function` 块（函数 runtime）                        | 它在 Tool Calls 表里没有模型发起的调用                           |

## 录制与回放

一局脚本游戏的时间几乎都花在等模型上。`pnpm llm:replay` 在模型前面放一个代理：第一遍把每个请求的回答录下来，以后同样的请求直接用录下的回答，不再调用模型。

一个参考数字：`lantern-barrow` 世界的三回合游戏有 47 次模型调用。录制用了 229 秒；回放时 47 次全部命中，用了 4 秒。

### 回放成立的条件

两遍游戏发出的请求必须**完全相同**。有一条不同，模型就会写出新内容，后面的请求全都跟着变。所以每一遍都要满足：

1. **固定游戏的 ID**：`--session-id <id>`。
2. **服务端设置 `COVEL_RANDOM_SEED`**：插件从 `ctx.random` 取的骰子和 ID 里的随机部分每遍相同。插件直接用 `node:crypto` 或 `Math.random` 取的数不受它控制。
3. **每遍开始时这个 ID 还不存在**：同一个 ID 不能建两次。最简单的做法是每遍用一个新的数据库文件。脚本通过后会删除游戏，所以也可以在同一个服务端上接着跑；失败或带 `--keep` 时游戏会留下，要先删掉。
4. **世界、插件、提示词、语言和模型配置都没有变**。改了其中任何一项，受影响的请求就是新请求。这也正是需要重新录制的时候。

### 回放仓库里录好的游戏

`tests/llm-replay/` 下每个文件夹是一局录好的游戏。录制随仓库提交，所以换一台机器之后，不需要模型、密钥和网络就能回放：

```bash
pnpm e2e:replay                  # replay every session
pnpm e2e:replay lantern-barrow   # replay one
```

一个文件夹里有三样东西：

| 文件            | 内容                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `scenario.json` | 这局游戏：`world`、`turns`、`locale`（默认 `zh-CN`）、`sessionId`、`seed`，以及传给脚本的其余参数 `args` |
| `llm.toml`      | 录制时用的模型。每个 `[covel.<用途>]` 都要写 `provider` 和 `baseUrl`；`baseUrl` 运行时会换成代理的地址   |
| `recording/`    | 每条请求一个回答文件                                                                                     |

对每局游戏，命令依次启动代理、一个专用的服务端和脚本，结束后全部停掉。

- 专用的服务端用临时目录里的新数据库和自己的 `COVEL_HOME`，并设置好随机种子和 `TZ=UTC`。它不读 `.env` 和 `~/.covel`，也不继承你终端里的 `COVEL_*`、`E2E_*`、`STORE_BACKEND` 等变量和各家密钥。所以两台机器发出同样的请求。
- 回放时每条请求都必须在录制里。有一条不在就判失败。脚本自己的检查失败也判失败。
- 脚本日志、服务端日志和用来匹配的请求写在 `debugs/llm-replay/<游戏>/`。
- `--verbose` 实时打印脚本的输出。

### 录制或重新录制

改了世界、插件、提示词或 `llm.toml` 之后要重录：

```bash
DEFAULT_BASE_URL=https://api.example.com   # origin of the endpoint, without /v1
DEFAULT_API_KEY=sk-...
pnpm e2e:replay --record lantern-barrow
```

- 录制不绑定某一家服务商。新请求发往 `DEFAULT_BASE_URL` 指向的 OpenAI 兼容接口。这两个变量可以写在环境里，或者仓库根目录的 `.env.llm` 里。末尾的 `/v1` 会被去掉。`--upstream <origin>` 可以临时换一个地址。
- 仓库里各局游戏的 `llm.toml` 都用 `provider = "default"`，所以密钥从 `DEFAULT_API_KEY` 读。
- 用哪个模型以 `llm.toml` 为准，你的接口要能提供它。换模型就改 `llm.toml` 再重录。
- 录制里已有的请求直接回答，只有新请求才发给模型。所以只改了一个插件的提示词时，重录只调用受影响的那部分。
- 游戏跑完（脚本以 `0` 或 `1` 退出）之后，这次没用到的旧回答会从 `recording/` 里删掉。中途出错的不删。
- 确认结果之后，把 `recording/` 的变动一起提交。

录制文件里是模型回答的原文。它不含密钥，也不含提示词。体积用 `du -sh tests/llm-replay/<游戏>/recording` 查看。提示词在 `debugs/` 下的 `*.requests` 里，比回答大得多，不进版本库。

新增一局游戏：复制一个文件夹，改 `scenario.json`，删掉 `recording/`，再录一遍。

### 自己手动录制和回放

只想在自己电脑上反复跑一局、不放进仓库时，可以分别启动代理、服务端和脚本。

先准备一份模型配置，把会用到的用途都指向代理，例如 `debugs/llm-replay/llm.toml`（`debugs/` 不进版本库）。下面假设真实的接口在 `127.0.0.1:3425`，服务商的名字和模型换成你自己的：

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

**录制。**开三个终端，依次启动。第一个是代理，`--upstream` 是真实接口的地址，不带 `/v1`：

```bash
pnpm llm:replay --mode record --fixtures debugs/llm-replay/demo --upstream http://127.0.0.1:3425
```

第二个是服务端。密钥仍然由服务端按服务商发送（这里是 `LOCAL_API_KEY`），代理原样转给真实接口：

```bash
SERVER_PORT=3160 COVEL_RANDOM_SEED=20261006 \
  COVEL_LLM_TOML="$PWD/debugs/llm-replay/llm.toml" \
  SQLITE_PATH="$PWD/debugs/llm-replay/run-a/covel.db" \
  COVEL_LOGS_DIR="$PWD/debugs/llm-replay/run-a/logs" \
  LOCAL_API_KEY=your-key \
  pnpm --filter @covel/server exec tsx src/index.ts
```

第三个是脚本：

```bash
pnpm exec tsx scripts/e2e-plugin-verify.ts --server http://localhost:3160/api \
  --world lantern-barrow --turns 3 --session-id lantern-barrow-replay
```

游戏结束后停掉服务端，再用 Ctrl-C 停掉代理。代理退出时打印统计，并写出 `debugs/llm-replay/demo.record.stats.json` 和 `debugs/llm-replay/demo.record.requests/`。

**回放。**代理换成回放模式，服务端换一个新的数据库文件，脚本的命令不变：

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

统计里 `served` 下的 `none 200` 是用录制回答的请求数，`proxy 200` 是转给真实接口的请求数。回放模式没有真实接口：没录过的请求得到一个错误，对应的 runtime 失败。

### 没有全部命中时

```bash
pnpm llm:replay:diff debugs/llm-replay/demo.record.requests debugs/llm-replay/demo.replay.requests
```

它列出第二遍里第一遍没有的请求，以及每条请求是从哪里开始和第一遍最接近的那条不同的。先看序号最小的那条：后面的多半是它引起的。

想让没命中的请求也有回答可看，第二遍也用 `--mode record`（同样带 `--upstream`）并加 `--tag <名字>`。没录过的请求会转给真实接口并补录。

`pnpm e2e:replay` 两遍的请求在 `debugs/llm-replay/<游戏>/record.requests` 和 `replay.requests` 里。录制如果是在另一台机器上做的，本机就没有 `record.requests`：先在本机录一遍，再回放比较。

### 代理怎样判断“同一条请求”

- 它比较整条请求的摘要。只看最后一条用户消息是不够的：故事之后运行的几个 agent，最后一条用户消息是一样的。
- 工具调用的 ID、UUID、时间戳和没有固定的游戏 ID 不参与比较。这是一层保险：Covel 放进提示词的内容本来就不带这些值，见[插件字段参考 · 输入和输出](../reference/plugins.md#输入和输出)。
- 流式的回答连同节奏一起录下。回放默认把延迟缩短到千分之一；`--speed 1` 按录制时的节奏回放。
- 代理重启后会加载已有的录制，录制模式下也是。
- 录制时模型在一个成功的流里返回过错误的请求，回放时仍然得到一个错误。所以服务端走和录制时相同的重试路径。

### 目前的范围

- 整局回放只在 `lantern-barrow` 的三回合游戏上验证过。更长的游戏、别的世界可能还有没处理的差异，用 `pnpm llm:replay:diff` 定位。
- 换机器带来的差异（仓库路径、`HOME`、时区、`LANG`、终端里的变量）只在一局停在创建角色的游戏上验证过。
- 回放时模型的回答从几秒变成几毫秒。如果提示词的内容取决于“后台任务和下一回合谁先完成”，两遍可能不同。上面那局游戏里没有出现。
- 仓库的 CI 不运行 `pnpm e2e:replay`。

## 没有按预期工作时

| 现象                                                           | 原因和处理                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED`，或者第 1 步就失败                              | 服务端没有启动。脚本不会启动它。改了端口时用 `--server http://localhost:<端口>/api`                |
| `preset not found`，或者说用途不存在                           | `--slot` 只写 `[covel.xxx]` 里的 `xxx`。`[covel.e2e_local]` 要写成 `--slot e2e_local`              |
| 模型请求返回 401                                               | 服务端没有拿到密钥。检查 `.env.llm` 和 `llm.toml` 里的服务商配置                                   |
| 某个插件全程 `SKIP`，原因是 `plugin not in session active set` | 这一局没有启用它。这是正确的结果。要测它就加 `--enable-plugins <id>`                               |
| 反复出现 `WARNING: SSE stream terminated prematurely`          | 和模型的连接中途断了。脚本会自动重新读取回合记录。Runtime Timeline 里都是 `success` 就可以当作通过 |
| 总结里 `rejected-and-retried` 很大                             | 模型经常传错工具参数。检查工具的参数说明和提示词                                                   |
| 输出语言检查失败                                               | 某个 runtime 用错了语言。先看“提示词语言”那一项指出的来源                                          |
| 想保留现场                                                     | 加 `--keep` 保留游戏；`--log-dir <path>` 换日志目录；`--verbose` 打印每个事件                      |
| 回放时有请求没命中                                             | 两遍的请求不一样。对照[回放成立的条件](#回放成立的条件)，再用 `pnpm llm:replay:diff` 找第一处不同  |
| 用录制代理时模型地址不对                                       | 直接把那个用途的 `baseUrl` 改成代理的地址                                                          |

## 接下来

- [打包并试装](./package.md)
- 在浏览器里验收玩家流程：[浏览器测试](../internals/e2e-testing.md#发版前的玩家流程验收)
- 这些命令的简表：[命令参考](../internals/commands.md)
