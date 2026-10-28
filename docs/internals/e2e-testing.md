# 浏览器端到端测试

这一页讲怎样在本地跑浏览器端到端测试（Playwright），怎样写一个新的 spec，以及发版前要手动验收哪些玩家流程。它写给改 Covel 源码的贡献者。

自动测试在本机运行，不需要 Docker。PostgreSQL 测试和下方的部署中继验收会用到 Docker。

## 快速开始

```bash
pnpm install
pnpm e2e
```

这会运行 `tests/e2e/` 下全部 Chromium spec。默认套件不访问真实模型，不花钱。

只想跑一个文件或一个测试时，把参数直接传给 Playwright：

```bash
pnpm exec playwright test tests/e2e/game-session.spec.ts
pnpm exec playwright test tests/e2e/game-session.spec.ts --grep "restore"
pnpm exec playwright test --project=chromium tests/e2e/i18n.spec.ts
```

需要一步步调试时：

```bash
pnpm e2e:ui
pnpm exec playwright test --debug tests/e2e/game-session.spec.ts
```

`pnpm e2e:ui` 打开 Playwright 的界面，`--debug` 逐步跑单个 spec。

### 测试服务是怎么起来的

没有设置 `E2E_BASE_URL` 时，Playwright 自己启动一套隔离的测试服务，跑完后全部回收：

| 服务            | 地址                    | 说明                                                                 |
| --------------- | ----------------------- | -------------------------------------------------------------------- |
| 服务端          | `http://127.0.0.1:3101` | 强制使用临时的 MemoryStore                                           |
| 打包后的页面    | `http://127.0.0.1:5183` | `apps/web/scripts/e2e-serve.mjs` 先构建到 `dist/web-e2e`，再提供页面 |
| Vite 开发服务器 | `http://127.0.0.1:5181` | 提供未打包的源码模块                                                 |

- 两份前端都把 `/api/*` 代理到 3101。
- 测试不会复用 `pnpm dev` 的 5173/3001 进程，所以旧的 Vite 缓存和本地 SQLite 数据不会影响结果。
- 每次运行都会重新构建，前端改动直接生效，不需要手动构建。
- 测试服务使用独立的临时 `COVEL_HOME`、用户世界目录和插件目录，进程结束后清理。它不会读取或改写你的 `~/.covel`。

### 两个 project

spec 分在两个 project 里。配置按文件内容自动归类，你不用手动登记。

| project        | 前端                    | 哪些 spec                                               |
| -------------- | ----------------------- | ------------------------------------------------------- |
| `chromium`     | 打包后的页面（5183）    | 其余全部                                                |
| `chromium-dev` | Vite 开发服务器（5181） | 在页面里加载应用源码模块的 spec（`import("/src/...")`） |

- 打包后的页面是玩家实际运行的版本，加载也快得多。开发服务器只有一个进程，要为每个新的浏览器上下文单独提供几百个模块，worker 再多也得排队。
- `chromium-dev` 的 `expect` 超时是 20 秒，其余是 5 秒。开发服务器在第一次请求时才转换模块，首屏耗时随机器负载变化。
- 只跑一个 project 时用 `--project=chromium` 或 `--project=chromium-dev`。

打包后的页面带内容安全策略，开发服务器没有。`tests/e2e/page-policy.spec.ts` 在主要页面和带插件面板的会话上检查没有任何策略违规。新 spec 想做同样的检查时，在第一次导航前调用 `watchPolicyViolations(page)`（`tests/e2e/helpers/page-policy.ts`），结束时断言返回的列表为空。

### 可访问性用例

```bash
pnpm e2e tests/e2e/catalog-accessibility.spec.ts
```

这个用例让 Vite 直接提供一份合成的测试页面，通过真实的组件目录和 PluginPanel 验证键盘操作、label 焦点、重复 ID 和 inert 锁。它不调用模型，也不调用 API。

> [!NOTE]
> 它属于 `chromium-dev`，不能在由服务端托管页面的生产构建上跑，也不在 CI 的冒烟测试里。改了界面的可访问性时，要自己单独跑它。

### 用自己启动的服务

如果你已经启动了服务，把 **Vite** 的地址传进来：

```bash
pnpm dev
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

设置了 `E2E_BASE_URL` 之后：

- Playwright 不再启动或回收任何服务，两个 project 都打开这个地址。服务和数据目录由你负责。
- 跑完整套件时，目标服务端必须使用 `STORE_BACKEND=memory`。只有不含 browser-checkpoint 用例的子集才可以指向 SQLite 或 PostgreSQL。
- 目标是由服务端自己托管页面的构建（设了 `SERVE_STATIC` 的生产或 Docker 环境）时，地址可以直接指向服务端。这时 `chromium-dev` 的 spec 加载不到源码模块，用 `--project=chromium` 只跑另一组。

### 用真实模型跑

AI 世界生成的界面流程由 `world-generation-progress.spec.ts` 用一个假的模型服务覆盖，几秒跑完（见[不访问真实模型的模型输出](#不访问真实模型的模型输出)）。

要用真实模型验证 AI 世界生成和三回合游戏流程，需要显式打开。这会产生模型请求和费用：

```bash
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
LIVE_LLM_ENABLED=1 pnpm e2e
```

## 编写 spec：共享辅助函数

`tests/e2e/helpers/player.ts` 提供会话类 spec 的公共动作和断言。新 spec 直接用它们，不要各自复制一份。

新 spec 默认在打包后的页面上跑。只有确实要在页面里调用应用内部模块时才写 `import("/src/...")`：这样的 spec 会自动归到 `chromium-dev`，在开发服务器上跑，慢得多。

| 辅助函数                     | 用途                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `composer` / `composerInput` | 定位主输入框（`data-testid`，不依赖 DOM 顺序）                |
| `waitForTurnStarted`         | 等待发送前的异步准备结束，并确认回合已经启动                  |
| `waitForTurnIdle`            | 等待已启动的回合真正结束                                      |
| `sendPlayerMessage`          | 输入、发送玩家消息并确认回合启动                              |
| `expectPlayerCanAct`         | 断言回合结束后玩家一定有可用的操作入口                        |
| `useServerWorlds`            | 让需要跨页面/API 状态的 spec 显式使用服务端世界与 MemoryStore |
| `seedAppSettings`            | 预置新手引导版本和界面语言，让 spec 直接落在世界列表          |

### 怎样判断回合结束

点击或输入完成，不代表异步读取或保存已经结束。用 Playwright 的定位器断言或 `expect.poll` 等到最终值；保存后要刷新页面时，先等持久化完成。React 单元测试用 `findBy*` 或 `waitFor` 等待真正要断言的结果；旁边的内容出现，不代表延迟加载的组件也已挂载。不要用固定时长的等待代替这些条件。

**读 `data-executing`，不要用 `input:disabled` 推断。**

- 点击会开始回合的按钮之后，先等 `waitForTurnStarted`，再等 `waitForTurnIdle`。发送前有一段异步准备，状态还没切到“执行中”时，对 `false` 的断言会提前成功。
- 回合执行中，输入框本来就是可用的（玩家可以插话）。用 `toBeEnabled()` 判断回合结束会立刻通过，等于没等。
- 输入框只在有必须回答的表单或选择时才禁用。这两种状态分别由输入区上的 `data-executing` 和 `data-blocked` 表示。

`expectPlayerCanAct` 检查的是一条不能破的规则：回合结束后，只要屏幕上没有必须回答的内容，主输入框就必须能接受自由输入。行动引导、场景快捷回复这类建议面板只是快捷方式，永远不应该锁住输入框。出现回归时这条断言会直接失败。

### 世界和会话存在哪里

使用 MemoryStore 时，Web 默认进入浏览器私有模式：世界和会话的数据存在当前浏览器的 `BrowserVault` 里，不会出现在 `/api/worlds`，换一个 Playwright 浏览器上下文也看不到。

- 要在后续测试或直接的 API 断言里复用世界的串行 spec，必须在首次导航前调用 `useServerWorlds(page)`，明确切换到服务端世界目录和临时 MemoryStore。
- 只验证浏览器持久化的行为时，在同一个 page 和上下文里完成。

### 所有 spec 共用一个服务端

一次运行里，所有 worker 连的是同一个服务端进程、同一个 MemoryStore，来源地址都是 `127.0.0.1`。写 spec 时按下面几条处理，否则单独跑能过、整套跑偶尔失败：

- **不要假设服务端是空的。** 调用了 `useServerWorlds` 的 spec 能看到其他 spec（包括正在并行运行的）创建的会话：世界卡片会多出“继续”按钮，会话准备页会列出已有会话。自己创建会话，按它的 ID 操作，并在 `finally` 里删除。
- **页面先画出来，数据后到。** `goto` / `reload` 之后，命令列表、会话列表、插件数据各自异步到达，中间状态是真实存在的。先用会重试的断言等到最终状态（例如 `toHaveCount(1)`），再对单个元素做断言。定位到多个元素的 strict-mode 错误不会重试，会立刻失败。
- **按 IP 计的限流是整套共用的。** 默认配置把测试服务的 `RATE_LIMIT_RPM` 调高了，但写死的额度仍然生效（例如 `/api/actions` 每分钟 30 次）。不需要真实回合的 spec 用 `page.route` 拦掉 `**/api/actions`。
- **失败截图在 `finally` 之后才拍。** 如果 `finally` 删除了会话或跳到了空白页，截图和页面快照里看到的是“重新连接中…”或白屏，不是失败时的页面。以错误信息和 call log 为准，需要现场时用 `--trace on`。

怀疑某个 spec 不稳定时，先单独重复运行它，再和整套一起跑：

```bash
pnpm e2e tests/e2e/reasoning-display.spec.ts --repeat-each=20 --workers=1
```

### 不访问真实模型的模型输出

需要模型输出、但不该访问真实模型服务的 spec 使用 `tests/e2e/helpers/fake-llm-provider.ts`。`startFakeLlmProvider()` 在测试进程里启动一个 OpenAI 兼容的假服务，监听 `127.0.0.1` 的随机端口：

- `provider.reply = (request) => ({ text, ... })` 决定每个请求的回答。
- `streamMs` 把回答均匀分散在一段时间内。
- `stall` 发出第一段后不再输出。
- `hold` 让回答停在最后一段之前，直到测试放行。用它可以在请求进行到一半时断言页面状态，不靠计时。
- `provider.requests` 按顺序记录收到的请求。

把页面请求指向它的做法见 `world-generation-progress.spec.ts` 的 `useFakeModel`：用 `page.route` 给请求加上 `X-Slot-Config`（一个 `baseUrl` 指向假服务的自定义模型配置）和 `X-Provider-Keys`，并把请求体里的 `model` 改成这个配置的 ID。页面、服务端路由、网关和 HTTP 适配器都是真实的，只有模型服务是假的。

> [!TIP]
> 不要靠真实等待来验证超时。等待时间是请求参数：世界创作接口的 `idleTimeoutMs` 最小可以是 1000。配合 `stall`，一秒多就有结论；配合 `streamMs: 2500`，可以证明“输出持续时间超过无响应超时仍能写完”。要验证的是这些性质，和默认的 120 秒无关。

世界生成用例在首次生成前延迟健康检查的响应，并断言请求使用 `saveTarget: "return-only"`。每个浏览器上下文单独保存结果，所以同名世界不会写进共享的服务端目录，影响后面的用例或重试。

## 插件流水线验证

想验证的是插件在完整回合里的表现，而不是页面时，用 HTTP API 驱动的脚本。它需要一个正在运行的服务端和真实模型：

```bash
pnpm e2e:verify
```

常用参数：

```bash
# 指定 llm.toml 中的 slot
pnpm e2e:verify --slot e2e_local --turns 5

# 聚焦单个插件
pnpm e2e:verify --plugin guide --turns 2
```

详细参数和输出格式见[用真实模型验证](../ship/real-model.md)。

`tests/llm-replay/` 下是脚本会话。录一遍要调用模型（三回合约 4 分钟），之后回放不调用模型，几秒跑完一局。录制只留在本机，不进版本库。它用来确认一次重构没有改变发给模型的请求：改之前在 `main` 上录，改完回放：

```bash
pnpm e2e:replay --record lantern-barrow   # 改之前，需要 DEFAULT_BASE_URL 和 DEFAULT_API_KEY
pnpm e2e:replay                           # 改之后
```

参数和录制的细节见[录制与回放](../ship/real-model.md#录制与回放)。

## 环境变量

| 变量                    | 默认值                                                                           | 说明                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `E2E_BASE_URL`          | `chromium` 用 `http://127.0.0.1:5183`，`chromium-dev` 用 `http://127.0.0.1:5181` | Playwright 页面导航地址；设了值表示使用你自己管理的外部环境          |
| `E2E_MODEL_SLOT`        | 不设（按配置的模型路由）                                                         | `pnpm e2e:verify` 让故事类 runtime 改用的 slot，等同于 `--slot`      |
| `LIVE_LLM_ENABLED`      | `false`                                                                          | 显式启用会访问真实模型服务的 Playwright/Vitest 流程                  |
| `COVEL_STORY_BASE_URL`  | 没有任何代码读取                                                                 | 不会覆盖 slot；代理地址直接写进 `llm.toml`                           |
| `COVEL_PLUGIN_BASE_URL` | 没有任何代码读取                                                                 | 不会覆盖 slot；代理地址直接写进 `llm.toml`                           |
| `CI`                    | `false`                                                                          | CI 模式下 Playwright 重试 2 次，只用 1 个 worker，并禁止 `test.only` |

## PostgreSQL 模式

需要用 PostgreSQL 后端跑本地服务时，先启动数据库：

```bash
pnpm db:up
pnpm dev:pg
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

这时要排除只支持 MemoryStore 的 spec（见[用自己启动的服务](#用自己启动的服务)）。

清理数据库容器：

```bash
pnpm docker:pg:down
```

## 输出位置

| 路径                  | 内容                            |
| --------------------- | ------------------------------- |
| `tests/e2e/artifacts` | Playwright trace / video 等产物 |
| `tests/e2e/report`    | HTML report                     |
| `debugs/e2e-logs`     | 插件验证脚本日志与 JSON 产物    |

这些目录已在 `.dockerignore` 中排除，不进入生产镜像上下文。

## 发版前的玩家流程验收

自动测试通过不等于游戏能玩。发版前按下面的顺序做。

1. 在本地顺序运行 `pnpm lint`、`pnpm test`、`pnpm e2e`。不要同时跑，它们共用构建目录。
2. 运行 `pnpm release:preflight`。
3. 本地已知的失败先修好，再推送。远端 CI 用来复核，并补上 Windows、macOS 等平台差异。

版本号的规则：

- 框架的发布标签要和根目录、`apps/`、`packages/` 的包版本一致。插件和世界包可以各自维护版本。
- 页面和桌面版的 preload 从应用包里读取版本。不要在翻译或运行时代码里另写一个版本常量。

改动涉及游玩或插件生命周期时，还要在一个隔离的数据目录里，用正式构建和真实模型走一遍玩家流程：

- 从选择世界、配置模型到提交角色。非法输入被拒绝后，仍然能修改并继续。
- 连续进行多个回合，检查正文、快捷回复、侧栏和自由输入。桌面和窄屏布局都要看。
- 中断、失败、刷新和重试之后能继续操作。已完成的剧情不重复提交，回合数不重复增加。
- 保存后重启，人物、故事、插件数据和设置都恢复，并再完成一个回合。
- 第三方插件以独立 ID 的 ZIP 安装，验证授权、拒绝、重复安装、启用、卸载和重新安装。确认已有存档可以继续使用，确定性的结算不会因为重试或重启而重复执行。

最后记录下来：实际用的模型、构建版本、每个流程的结果，以及没有覆盖到的边界。

> [!IMPORTANT]
> 默认 E2E 里被跳过的真实模型用例，不能算作真实模型验证。接口返回成功，也不能代替在页面上走完整个流程。发布之后，再下载产物核对版本、资源和启动结果。

完整的发版步骤见[发版清单](./desktop-packaging.md#release-checklist)。

## 桌面版与部署版的本机模型中继验收

这套流程用于复测“部署在另一台机器的 Covel，调用玩家电脑上的模型”。连接测试成功只是第一步，还要让角色创建、叙事和默认插件真正运行。使用独立测试存档；模型调用会产生费用。

### 准备环境

1. 记录待测提交和构建版本。桌面版按[桌面打包](./desktop-packaging.md)构建正式产物，以隔离的测试数据目录启动。
2. 部署版使用仓库的 `docker/Dockerfile`，配置与 `render.yaml` 一致，尤其是 `NODE_ENV=production`、`STORE_BACKEND=memory`、`DEPLOYMENT_TIER=self` 和静态页面。给容器设置同样的内存限制；端口只映射到宿主回环地址。临时环境文件放在版本库外，限制文件权限，不挂载个人配置目录。
3. 打开网页，检查 `/api/health` 显示 `browser-private`、`modelRelay: true`、`memory` 和前端 `local`。桌面版应是 `personal`，不需要浏览器中继。
4. 启动本机模型网关。在 Covel 设置里选择实际协议、Base URL 和模型，把故事、插件、记忆等需要的用途都绑定好。密钥只填设置界面。Magpie 的网页来源许可和网关密钥见[Magpie 网页接入](../start/hosted-trial.md#magpie)。
5. 分别测试模型列表和连接。检查容器内的同一回环端口连接失败，而浏览器可以访问模型；容器不能通过宿主网络或代理绕过中继。

本地 Docker 可以验证部署配置和客户端回环地址的归属，不能代替线上 HTTPS 页面的浏览器权限、证书、反向代理和冷启动验收。线上版本更新后再补测这些项。

### 实际游玩与重启

1. 新建世界会话，等插件计划加载完成再开始。保留世界默认组合，核对自动补齐的依赖仍在启用集合里；不能先手动打开依赖再把默认流程记为通过。
2. 点击开始冒险，完成开局表单和角色创建。确认没有“模型配置有误”、依赖缺失或运行任务失败；展开正文下方的“执行 · N 个运行任务”核对结果。
3. 等待开场正文和插件结算。至少完成两次玩家回合：一次选择快捷回复，一次自由输入。让剧情明确发生一项任务或物品变更，核对对应面板、角色状态和回合记录；不把 HTTP 200 或工具调用成功当成数据已经保存。
4. 浏览器网络检查仅提取模型请求的路径、状态和目标地址。预期实际模型请求到达玩家回环地址；同时检查普通调用、流式叙事和函数插件的模型调用。不要导出带请求头的 HAR。
5. 等待结算完成，重启 Docker 容器，重新打开同一存档。确认故事、角色、插件集合和数据恢复，再完成第三次玩家回合。桌面版则退出并重启同一正式产物，以同一个测试数据目录继续。
6. 单独检查失败恢复：无效测试凭据应显示认证错误；来源未获许可应显示浏览器访问失败。修正配置后能重试，且不重复提交剧情或增加回合。不要为测试修改用户已有凭据或撤销既有许可。

### 保存可复用结果

报告只记录提交、应用和浏览器版本、模型协议、模型名称、匿名测试场景、通过/失败、错误类别以及未覆盖项。个人绝对路径用 `<test-data-dir>`，来源用 `<test-origin>`，凭据用 `<gateway-key>`；不保存实际替换值。

不要记录密钥、令牌、认证头、环境文件内容、浏览器存储导出或包含这些信息的截图。分享前检查日志和截图，移除个人路径、账户信息和真实会话标识。原始调试文件留在被忽略的 `debugs/`，不随文档或 PR 上传。

<!-- prettier-ignore -->
| 检查项 | 通过标准 |
| --- | --- |
| 正式桌面产物 | 开局、两回合、重启后第三回合均完成 |
| Docker 部署形态 | 健康检查正确，容器本身无法访问玩家回环端口 |
| 浏览器中继 | 实际游戏请求到达玩家本机，流式输出正常 |
| 默认插件 | 依赖完整，相关任务成功，数据出现在面板并可恢复 |
| 失败恢复 | 错误可识别，修正后可继续，无重复提交 |
| 线上补测 | 单独标明 HTTPS、权限、代理和冷启动的实测结果 |
| 记录隐私 | 无个人路径、密钥、令牌或请求头 |

### 截图与 README 更新

1. 从实际验收存档取图，使用虚构角色资料。文字玩法可用余烬岭，舞台玩法可用遥风学园；先完成一个玩家回合，确认默认插件正常结算。
2. 固定视口为 **1600 × 1000 CSS 像素、缩放 100%、设备比例 1**。主功能图使用**面板**方案和深色模式、简体中文界面；不要把浏览器工具栏、桌面窗口边框、扩展悬浮按钮或会话里的“跳到最新”按钮截进去。
3. 文字玩法和判定图取自同一存档，侧栏换成不同面板，避免两张图重复同一视角。舞台图保留实际背景、立绘与已显示完整的对话。
4. 等待模型、字体、图片和过渡动画完成再截图。通过正常导航、面板切换和滚动取景，不改写 DOM、剧情或运行状态来拼出成功画面。
5. README 只精选有辨识度的画面，每张说明不同的产品特点；省略空表单、普通列表和重复视角，其余截图只作本地验收。替换 `.assets/images/readme/` 中的入选图片，移除不再引用的旧图，同步中英文 README 的引用、替代文字和说明。每张 PNG 不超过 3 MiB；逐张检查尺寸、清晰度、裁切和隐私，再运行文档检查。页首的演示动图保留；它和当前界面差别明显时，按[贡献指南](../CONTRIBUTING.md#官网演示媒体)重新录制，不用静态截图代替。

回归记录注明截图对应的提交、场景、回合、主题与视口。若截到了密钥、个人路径或账户信息，重新取景，不把原图提交到仓库。

## 失败排查

| 现象                     | 怎么办                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 端口已占用或页面打不开   | 默认的测试 Vite 是 `5181`，打包后的页面是 `5183`，API 是 `3101`。Vite 启用了 `strictPort`，不会悄悄换到别的端口。停掉占用端口的进程后重试。要用自己启动的页面，就设置 `E2E_BASE_URL`，并自己保证后端类型符合目标 spec。  |
| 等待 API health 超时     | 默认运行检查 `http://127.0.0.1:3101/api/health`；外部环境检查它实际的服务端地址。PostgreSQL 流程先运行 `pnpm db:up` 和 `pnpm dev:pg`，再让 `E2E_BASE_URL` 指向对应的页面，并排除只支持 MemoryStore 的 spec。             |
| 模型调用或角色创建失败   | 浏览器里的真实模型 spec 使用应用配置的 `story`、`plugin` 等用途。`pnpm e2e:verify` 也按配置路由，只有传了 `--slot` 或设了 `E2E_MODEL_SLOT` 才改用指定的 slot。分别确认需要的 slot 存在，并且 `.env.llm` 里有对应的 key。 |
| 需要定位异步失败         | 失败时 Playwright 保留截图；trace 和 video 只在第一次重试时保留。用 `pnpm exec playwright show-report tests/e2e/report` 打开 HTML 报告。                                                                                 |
| 找不到插件验证脚本的输出 | 脚本默认写到 `debugs/e2e-logs/`。只想在终端里看时传 `--no-log`；想保留会话和快照时传 `--keep`。                                                                                                                          |
