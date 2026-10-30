# 术语表

这一页给 Covel 文档、代码和界面里用到的词下定义。同一个东西在不同地方叫法不一致时（例如界面写“模型用途”，代码写 slot），以这一页为准：改别处，不改这里。

条目按英文字母排序。每条先用一两句话说清楚它是什么，再给出详细页面。

## Terms in Chinese

一个英文术语只对应一个中文说法。中文文档、界面文字和中文提示词（`*.zh.md`）都用这张表里的说法。

<!-- prettier-ignore -->
| Term | 中文 | 说明 |
| --- | --- | --- |
| Action | 行动 | 玩家一次提交里的一项：从哪个座位、以哪个角色、做哪种事（`submit_actions`）。 |
| Action kind | 行动类型 | 一种行动：内核的 `say`、`act` 等，或插件声明的 `<pluginId>/<name>`。 |
| Alias | 别名 | 同一个角色的另一个名字（`aliases`）。不是字段或 ID 的兼容名。 |
| Binding | 绑定 |  |
| Bundled plugin | 内置插件 | 随 Covel 一起安装的插件。不等于 `kind: core`。 |
| Capability | 能力标签 | 一条模型路由的 `tag`（`text`、`image` 等）。找插件靠的是 **Contract**，不是能力标签。 |
| Capability snapshot | 能力快照 | 安装记录里的声明能力上界；见[可信来源](./plugin-installation.md#可信来源)。 |
| Collection | 合集 |  |
| Contract | 契约 | 带版本号的 ID，例如 `narrative-engine@1`。 |
| Credits | 作者信息 | 一个包的 `author`、`license` 和 `homepage` 字段。 |
| Dataset | 数据集 | 插件声明的带类型数据（`contributes.datasets`）。不是安装用的 **Collection**。 |
| Deployment form | 部署形态 | 桌面客户端、自部署网页版、官方网页版。不是 `DEPLOYMENT_TIER`。 |
| Edition | 语言版本 | 世界的一种语言：`defaultLocale`，以及根目录里每个 `world.<locale>.yaml` 或 `WORLD.<locale>.md` 的语言。 |
| Fault latch | 熔断 | 辅助插件在同一会话连续因自身故障失败后暂停，可由玩家重新启用；只在进程内存中保存。见[协议](./protocol.md#插件故障熔断)。 |
| Execution | 执行 | 一次调度及其提交计划；玩家回合、手动调用和后台作业都可以发起执行。 |
| Finalizer step | 收尾步骤 | agent 用完步数后关掉工具、要求直接给出答案的那一次请求。 |
| Kernel | 内核 |  |
| Local model relay | 本地模型中继 | 共享形态的服务端经玩家浏览器访问玩家电脑或局域网上的模型。见[安全边界](../internals/security.md#local-model-relay)。 |
| Official web app | 官方网页版 |  |
| Operation-based write | 操作式写入 | 交一串操作（`plugin.data.update`），不交算好的整个值。 |
| Pack | 玩法包 |  |
| PluginType | 插件类型 |  |
| Preset | 预设 |  |
| Proposal | 提案 |  |
| Provider | 提供商 |  |
| Recursive call | 嵌套调用 | 包内 runtime 调用，写入随父执行一起提交；不同于只交回输出的子 agent。 |
| Roleplay notes | 扮演说明 | 世界作者写在角色记录的 `blueprint` 字段里、告诉叙事怎样演这个角色的内容；由“角色资料”插件读取。不是角色本身。 |
| Runtime | runtime | 保留英文：它指清单里的一个运行单元，不是泛指“运行时”。 |
| Runtime manifest | runtime 清单 |  |
| Seat | 座位 | 会话里“谁在玩、以什么身份、控制哪些角色”（`session.seats`）。 |
| Segment | 提示词段 |  |
| Server-scoped setting | 服务端设置 | `scope: "server"` 的设置；其余的是本设备设置。 |
| Session | 会话 |  |
| Slot | 槽位 | 设置界面里叫“模型用途”。 |
| Stop reason | 结束原因 | agent 工具循环怎样结束（`RuntimeResult.stop.reason`）。 |
| Sub-agent | 子 agent | 另一个 runtime 在自己的执行里运行、只交回输出的 agent runtime。 |
| Tool result | 工具结果 | 代码读取的内容与模型看到的反馈是两种形状；工具成功不代表已保存。 |
| Trigger mode | 触发模式 |  |
| Trusted source | 可信来源 | 实例所有者或运营者选定的 GitHub 来源，只减少审批提示。 |
| Turn | 回合 | “This turn” 是“本回合”。 |
| World | 世界 | 世界的安装包叫“世界包”。 |

## Prompt vocabulary

提示词正文里，描述 runtime 读什么、写什么时用的词。一个东西只用一个词：用了 `turn` 就不再写 `round`，用了 `record` 就不再写 `row`。写法见[提示词写法](../plugins/prompt-style.md)。

<!-- prettier-ignore -->
| Term | 中文 | 意思 | 不要用这些词来指它 |
| --- | --- | --- | --- |
| turn | 回合 | 玩家的一条消息，以及各个 runtime 为它做的全部事情 | round |
| narrative | 叙事 | 叙事 runtime 在本回合写出的故事正文 | story text, prose, the output |
| player | 玩家 | 玩游戏的人 | user |
| player character | 玩家角色 | 玩家控制的角色 | protagonist, hero, PC |
| NPC | NPC | 不由玩家控制的角色 |  |
| character | 角色 | 玩家角色或 NPC |  |
| tool | 工具 | runtime 可以调用的一个函数 | function, API |
| call | 调用 | 使用一次工具 | invoke, run, trigger |
| record | 记录 | 插件数据里存下的一项 | row, object |
| entry | 条目 | 玩家读到的列表里的一项，例如图鉴条目 | item（item 指行囊里的物品） |
| item | 物品 | 角色随身带的东西 |  |
| dimension | 维度 | 由世界定义、随故事变化的一项世界状态 | attribute（attribute 是角色的） |
| attribute | 属性 | 角色的一个数字或文字字段 | stat |
| world rule | 世界规则 | 提示词里带着的一条世界规则 | lore entry |
| quest | 任务 | 故事交给玩家的一个目标 | mission, task |
| event | 事件 | 叙事里发生的一件事，或者 runtime 之间传递的一个信号 |  |
| check | 判定 | 用骰子对抗一个难度 | test, roll（roll 指掷一颗骰子） |
| scene | 场景 | 叙事此刻所在的地点和时间 |  |
| inject | 注入 | 框架把一块数据放进提示词 | insert, provide |
| block | 区块 | 提示词里带标签的一段，例如 `<existing-quests>` | section（section 指一个标题小节） |

## Action

玩家一次提交里的一项。它写明从哪个座位提交（`seatId`）、以哪个角色（`actorId`）、是哪种行动（`kind`），以及文字或结构化字段。表单和选项的回答也是行动。服务端按座位身份校验每个行动，再渲染成给模型看的 `playerMessage`；函数 runtime 从 `ctx.playerActions` 读到它们。

详见：[HTTP API：submit_actions](./api.md#submit_actions)。

## Action kind

一种行动。内核有六个基础类型：`say`（说话）、`act`（行动）、`narrate`（旁白）、`direct`（导演指示）、`advance`（推进）、`command`（斜杠命令）。插件在 `contributes.actionKinds` 里声明自己的类型，线上写作 `<pluginId>/<name>`。座位身份决定能提交哪些类型。

详见：[插件字段参考：行动类型](./plugins.md#行动类型contributesactionkinds)、[世界模型：座位](./world-model.md#座位)。

## Alias

同一个角色的另一个名字：绰号、专指某个人的头衔，或者用另一种文字写的名字。角色记录把它们放在 `aliases` 里，和 `name` 并列。

在一局游戏里，一个名字或别名只指向一个角色。`resolveCharacter` 可以把 ID、名字或别名解析成角色；如果两个角色用了同一个名字，它会报告有歧义。

详见：[世界模型](./world-model.md#别名与按名字解析)。

## Binding

一条数据通路：一个 runtime 说“我要读另一个 runtime 的结果”。它写在 `io.inputs.<名字>` 里。

- 同一个包内，按 runtime ID 找到上游；跨包时，按带版本的契约找。
- 可以用 JSON Pointer（RFC 6901）只取结果里的一部分。
- 取到的值会按 `accepts` 校验，再连同它的来源一起交给 `ctx.inputs` 或 agent 的提示词。
- 写 `scope: committed` 时，读的是之前某次执行已经保存下来的结果，而不是本次执行的。

详见：[插件字段参考](./plugins.md)、[回合管线](../internals/flow.md)、`packages/shared/src/types/runtime-scheduling.ts`。

## Bundled plugin

内置插件是随 Covel 一起发布、放在 `plugins/` 下的插件。它的来源是 `builtin`，代码不用玩家批准就能运行；社区插件的代码要玩家批准。内置插件是示范，不是框架的一部分：删掉任何一个，框架都应当照常运行。它和 `kind: core` 不是一回事：`kind` 决定插件默认是否加入每一局。

详见：[内置插件与功能](../builtin/index.md)、[插件字段参考](./plugins.md)。

## Collection

一份清单（`covel-collection.yaml`），列出要一起安装的世界和插件，也可以包含别的仓库里按提交固定的包。

它只在安装时起作用。装下来的仍是普通的插件和世界，各自单独更新和卸载。它和 **Pack** 不同：Pack 是在已经装好的插件里做选择。它也不是 **Dataset**（数据集）：数据集是插件声明的带类型数据。

详见：[合集](../ship/collections.md)、[插件安装](./plugin-installation.md)。

## Contract

一个带版本号的 ID，例如 `narrative-engine@1`，用来说明一个插件提供什么能力，或者需要什么能力。

- 根 `PLUGIN.md` 用 `requires`、`conflicts` 列出需要和不能共存的契约，用 `provides` 列出不由 runtime 输出的契约。
- runtime 用 `io.output.contract` 发布一个契约（插件因此提供它），用 `from: { contract }` 读取一个契约。
- 内核按契约找提供者，从不写死某个插件 ID。所以提供同一个契约的插件可以互相替换。
- 只支持当前版本。不兼容的改动要换一个新 ID（`@2`）。

详见：[插件字段参考](./plugins.md)，以及根目录 `AGENTS.md` 的 “Framework ↔ Plugin Isolation Rule”。

## Credits

插件、世界或合集清单里可选的 `author`、`license`、`homepage` 字段：谁做了这个包，去哪里找到他们。作者信息里还可以带一段简短的话（`about`）和几个带名字的 `https` 链接。

它只用于展示，在开始游戏之前显示。框架不根据它做任何判断；玩家确认了第三方链接提示之后，链接才会打开。

详见：[作者信息](./plugins.md#作者信息)、[安全边界](../internals/security.md#package-credits-and-author-links)。

## Dataset

数据集是插件用 `contributes.datasets` 声明的一类带类型的插件数据：名字就是插件数据的 namespace，每条记录要满足一份 JSON Schema，还可以写作为键的字段和允许的操作种类。

它和 **Collection** 无关：Collection 是安装时用的清单（`covel-collection.yaml`）。提交时，插件写入自己数据集的每一条 proposal 都按声明的操作种类和 schema 校验。

详见：[数据集](./plugins.md#数据集contributesdatasets)、[世界数据](./world-data.md)。

## Deployment form

部署形态是 Covel 的三种运行方式：桌面客户端、自部署网页版和官方网页版。现在支持前两种，官方网页版还不支持。各自的存储方式见[存储](../internals/storage.md)。商业版现在没有做，本仓库不为它更新。

它和部署档位（`DEPLOYMENT_TIER`）不是一回事：档位决定鉴权和安全检查有多严，见[安全边界](../internals/security.md)。

## Extension point

内核定义的一个带版本的接入点，由插件来实现，例如 `prompt.segment@1` 或 `ui.slot@1`。

插件在 `contributes.extensions` 里声明自己要实现哪个，再用 `covel.provideExtension()` 注册。一个接入点有多个实现时怎样合并，由它的模式决定：`single`（只取一个）、`collect`（全部收集）或 `pipeline`（依次处理）。

它和插件的 **Contract** 不同：Contract 是一个插件定义、给别的插件用的。

详见：[扩展点](./extension-points.md)、[插件扩展与通信](./plugin-extensions.md)。

## Execution

执行是一次管线调用，带有自己的身份、冻结的注册表与读取底本、各 runtime 的结果和提交计划。`execution.origin` 说明它因何开始，例如玩家行动、手动调用、后台作业或嵌套调用。恢复会接着被挂起的执行继续。

`turnId` 标识执行；`runId` 标识某个 runtime 的一次尝试。两者都不是逻辑回合号。setup、开场、手动运行和后台作业不增加 `completedPlayerTurns`；一个已提交的玩家回合最多增加一次。

详见：[回合管线](../internals/flow.md)、[执行和提交](./protocol.md#执行和提交是两步)。

## Finalizer step

agent runtime 用完步数之后，内核再发的一次模型请求：关掉工具，要求模型根据已有的信息直接给出最终答案。

步数用完本身不算成功。只有收尾步骤写出了答案，runtime 才成功，结果的 `stop.finalizer` 为 `true`。输出由完成工具交出，或者完成条件还没满足时，不发收尾请求。

详见：[协议参考的结束原因](./protocol.md#stop-reasons)。

## Kernel

框架的核心：它安排回合、组装提示词、驱动模型调用工具、校验提案，并把结果保存下来。`plugins/` 目录之外的代码（`packages/`、`apps/server/src/`、`apps/web/src/`）都属于内核。

详见：[回合管线](../internals/flow.md)。

## Narrator-only

`WORLD.md` 里夹在 `<!-- narrator-only -->` 和 `<!-- /narrator-only -->` 两行之间的部分。模型会读到它；“世界”页签、开局准备页和世界详情页不显示它。

它的作用是不向玩家剧透，并不是保密：世界记录和包里的文件都保存着全文。满足条件才揭示的内容是另一种机制，叫隐藏数据（`visibility: hidden`）。

详见：[世界数据](./world-data.md)。

## Official web app

官方网页版是 Covel 项目打算部署给所有人用的网页版，现在还不支持。按设计，存档以玩家浏览器里的为准（存储配置 `browser-private`），不写进服务器的数据库。公开体验站已经用这个形态运行，限制见[在公开体验站上玩](../start/hosted-trial.md)。

详见：[存储](../internals/storage.md)、[存储模式说明](./api.md#存储模式说明)。

## Operation-based write

操作式写入是对一个插件数据键交一串操作（`inc`、`upsertItem` 等），而不是先读出值、算好、再整个写回。插件用 `ctx.pluginData.update` 或 `plugin.data.update` 提案提交；内核在提交事务里把这些操作应用到最新存的值上。所以两次同时的“金币 +1”都会生效。

详见：[事务 · 操作式写入](./transactions.md#操作式写入plugindataupdate)。

## Pack

一组起了名字的插件（`requested` 和 `recommended` 两个集合，加上标签），合起来构成一种玩法，例如 `traditional-story`、`dialogue-mode`。

玩家在开局准备页选一个玩法包，就一步换掉上一个玩法包带来的插件；世界自己要求的插件和玩家手动选的插件保持不变。世界用 `pluginPolicy.preset` 指定默认的玩法包，用 `pluginPolicy.plus` 加上自己要的插件。玩法包只有内置的那些（`packs/builtin.yaml`），世界不定义自己的玩法包。

它和 **Preset** 不同：Preset 打包的是模型的选择，不是插件。

详见：`packs/builtin.yaml`、`apps/server/src/config/plugin-packs.ts`、[插件字段参考](./plugins.md)、[世界数据](./world-data.md)。

## Plugin kind and source

描述一个插件有两个互不相干的角度。

- **kind**：根 `PLUGIN.md` 里的字段，有两个值。`core` 的插件会加入每一局游戏，除非玩家明确排除；`plugin` 的插件要选了才启用。加载后的包清单和插件摘要保留 `kind`；编译后的运行时不重复这个字段。
- **来源**（`builtin` 或 `community`）：由插件所在的目录决定，不看清单，也不看名字。它决定插件是否自动加载、工具怎样审批，以及服务端代码是否需要玩家授权。

官方维护、但从仓库之外安装的插件，来源仍然是 `community`。

详见：[插件字段参考](./plugins.md)、[插件安装](./plugin-installation.md)、[工具](./tools.md)。

## Preset

内部使用的一份模型方案，包含服务商、端点、协议和一个原样传递的模型 ID。

设置界面展示的是更直观的“服务商 → 模型”层级，只在发出请求时才把界面里定义的模型编译成预设。用户不直接管理预设。

详见：`packages/settings/src/`。

## Proposal

插件提出的一次写入请求。内核校验通过后才真正写入，插件从不直接写数据库。

提案的类型只在一处定义：`ProposalPayloadMap`（`packages/shared/src/types/proposal.ts`）。目前有：`narrative.append`、`event.emit`、`interaction.request`、`ui.render`、`asset.generate`、`plugin.data`、`plugin.data.batch`、`plugin.data.delete`、`plugin.data.update`、`character.upsert`、`character.schema.set`、`dimension.initialize`、`dimension.update`、`lorebook.upsert`。

详见：[事务](./transactions.md)、[回合管线](../internals/flow.md)。

## Provider

一个具体的模型服务：文本、图像或向量（OpenAI、Anthropic、DeepSeek、阿里云百炼等）。用哪个服务商由槽位的路由决定，通过 AI 网关调用，插件代码从不直接调用它。

详见：`packages/ai-provider/`、[插件字段参考](./plugins.md)。

## Recursive call

通过 `ctx.recursiveCall` 调用本插件内的另一个 runtime。它可以产生领域写入；嵌套结果与父结果组成同一个提交单元，父调用失败时子调用写入也丢弃。它不同于子 agent：子 agent 只交回输出，而且可以按契约选择其他包的提供者。

详见：[嵌套调用](./plugins.md#嵌套调用ctxrecursivecall)、[子 agent](./plugins.md#子-agent)。

## Runtime

插件里真正被执行的单元。有两种：

- `agent`：由模型驱动，把 `RUNTIME.md`（或根清单里内联的 runtime）的正文当作系统提示词。
- `function`：由 JavaScript handler 执行；需要时可以调用工具、服务或模型。

一个插件包可以有多个 runtime，各有自己的触发方式、阶段和依赖关系。

详见：[写插件要知道的规则](../plugins/essentials.md)、[插件字段参考](./plugins.md)。

## Runtime manifest

加载器把作者写的 runtime 编译成的内部执行结构。作者写的 runtime 可以是根 `PLUGIN.md` 里内联的 `runtime`，也可以是 `runtimes/<id>/RUNTIME.md`。

- 作者写的是分组字段：`type`、`schedule`、`io`、`agent`、`function`、`guard`、`effects`、`permissions`。
- 编译出的 `RuntimeManifest` 带有 `pluginId`、`name`（即 runtimeId）、`trigger`、调度信息（`stage`、`needs`、`after`、`inputs`）、`outputKind`、`outputContract`、`model` 和 `permissions`。

内部字段不是作者格式，不能照抄进 `PLUGIN.md`。

详见：[插件字段参考](./plugins.md)、[写插件要知道的规则](../plugins/essentials.md)。

## Seat

会话里的一个位置：谁坐在这里（人类或空置）、以什么身份（玩家、主持人、旁观者）、控制哪些角色、当前扮演哪一个。座位存放在会话记录的 `seats` 上。新会话有一个人类玩家座位，绑定所有 `type: player` 的角色。故事跟随主座位的当前角色。

详见：[世界模型：座位](./world-model.md#座位)、[HTTP API](./api.md#会话座位)。

## Segment

组装好的提示词里的一段（提示词结构规范把提示词分成 10 段）。段和缓存有关：稳定的段（世界观、插件提示词）会带上 `cache_control` 标记，让服务商一侧的提示词缓存可以跨回合复用。

详见：[提示词结构](./prompt-structure.md)。

## Server-scoped setting

由服务端自己执行的玩家设置，例如诊断记录保留多久。设置项在注册时声明 `scope: "server"`；服务端把值存进自己的数据库，同一个安装里的所有浏览器共用一个值，并且只有 `self` 部署允许玩家修改。

其余的设置都属于客户端：它们是某一台设备的偏好。

详见：[设置存储](./settings-store.md)。

## Session

一局正在进行的游戏。它的 ID 形如 `{worldId}-{uuid8}`，固定属于一个世界，有自己的回合计数、启用的插件、快照和事件。

详见：[HTTP API](./api.md)、[事务](./transactions.md)。

## Slot

选模型用的一个具名路由键（`story`、`plugin`、`memory`、`image` 等），在设置界面里叫**模型用途**。

插件清单里只写槽位的名字；`llm.toml` 或保存下来的“服务商/模型”设置把它绑定到具体的模型。备用模型只在同一类输出之内选择：图像请求不会落到文本模型上。

详见：[模型用途](./slots.md)、`llm.toml.example`。

## Stop reason

agent runtime 的工具循环怎样结束，例如 `completed`（模型给出了最终回复）、`max-steps`（用完了步数）或 `cancelled`（被取消）。一共十个标识符。

它写在 `RuntimeResult.stop` 和 runtime 生命周期事件的 `stopReason` 里。函数 runtime 没有结束原因。

详见：[协议参考的结束原因](./protocol.md#stop-reasons)、[回合管线](../internals/flow.md)。

## Sub-agent

另一个 runtime 在自己的执行里运行的 agent runtime：函数用 `ctx.agents.run`，agent 用 `delegate` 工具。它拿着调用方给的简报，用自己的对话记录和预算运行，只交回输出，不写数据、不发事件，也不形成提交单位。提供方写 `schedule.subagentOnly: true`，调度器从不自动运行它。

详见：[插件参考 · 子 agent](./plugins.md#子-agent)、[delegate 工具](./tools.md#子-agentdelegate)。

## Tool result

一次工具调用的返回。插件代码可以直接返回业务内容，也可以用 SDK 的 `covel.tool-result` 分开内容、模型反馈和待提交副作用。执行器把模型反馈整理成成功信封或 `error` 信封。已暂存的写入仍可能在提交时被拒绝。

详见：[工具结果契约](./tools.md#工具结果契约tool-result)。

## Trigger mode

一个 runtime 怎样决定这个回合要不要运行：`auto`（默认）、`manual` 或 `event`。只有这三种，清单里写了别的值会在加载时被拒绝。

它和两样东西配合使用：

- `stage`：`auto` 的 runtime 属于哪个阶段。`event` / `manual` 的 runtime 不写阶段。
- `auto` 的节奏：`schedule.every`（每几个回合运行一次），以及 `schedule.trigger` 里的 `cooldownTurns`、`maxTriggerCount`、`startTurn`。

详见：[插件字段参考](./plugins.md)。

## Turn

会话循环走一圈：玩家输入 → 决定触发哪些 runtime → 按阶段执行（一个阶段全部完成后才进入下一个，阶段内按依赖顺序）→ 校验提案 → 提交 → 通过 SSE 推送给界面。

每次执行有一个不透明的 `turnId`。已提交的玩家回合会让 `completedPlayerTurns` 这个只增不减的计数前进，每个逻辑回合最多一次。走哪一组阶段由 `session.phase` 决定：`setup` 运行 setup 阶段，`playing` 运行 `pre-turn → narrative → post-turn → audit`。

详见：[回合管线](../internals/flow.md)、[SSE 协议](./protocol.md)。

## World

一个内容包（`worlds/<id>/`），里面有 `world.yaml`、`WORLD.md`，以及放在约定路径上的可选数据（`data/dimensions.yaml`、`data/rules/` 等），用来提供维度、角色设定、规则、场景和媒体索引。

服务端启动时从两个地方加载世界：内置目录 `COVEL_WORLDS_DIR`，和用户世界目录（`COVEL_USER_WORLDS_DIR`，没有设置时是 `<COVEL_HOME>/worlds`，默认的 home 是 `~/.covel`）。一个世界可以开很多局游戏。加载过程见[启动加载与收敛](./world-data.md#启动加载与收敛seed--reconcile)。

详见：[世界数据](./world-data.md)。

## Related

- **pluginId 和 runtimeId 的区别**：见[Runtime manifest](#runtime-manifest)：`pluginId` 标识包、隔离和写入归属，`name` 是 runtimeId，标识调度与追踪。
- **插件来源**：见上面的 “Plugin kind and source”，以及[工具](./tools.md)。
- **这里没有收录的词**：`Branch`、`Snapshot`、`PluginData`、`CharacterRecord`、`Lorebook`，见[事务](./transactions.md)。
