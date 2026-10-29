# 第一个插件

这一页先写一个只有一个文件的插件，再带你做一个插件“酒馆传闻”：每个回合结束后，它读一遍刚写出的故事，把主角听到的传闻记下来，显示在侧栏的面板里。完成后，你会走过一个插件的完整流程：生成、校验、离线运行、修改、装进游戏。

全程约三十分钟。会用到命令行；要读懂生成的代码需要一点 JavaScript 基础，但这一页不要求你写代码。

## 开始之前

- 已经[从源码运行](../start/run-from-source.md)过 Covel。脚手架和校验命令都在仓库里。
- 已经[连接模型](../start/models.md)。最后一步要在游戏里真实运行。
- 读过[插件是什么](./index.md)，知道 agent 和函数的区别。

下面的命令都在 Covel 仓库的根目录运行。

## 1. 一个文件就是一个插件

最小的插件只有一个 `PLUGIN.md`：一句说明、一个运行阶段和一段提示词。建一个文件夹，文件夹名就是插件的 ID：

```bash
mkdir -p ~/.covel/plugins/observer
```

在里面保存 `PLUGIN.md`：

```yaml
---
description: Adds a short observation after each turn.
runtime:
  schedule: { stage: post-turn }
---
Write one short observation grounded in the latest narrative.
```

校验它：

没有源码的玩家可以在设置的安装与管理里点“校验”。

```bash
pnpm validate:plugin ~/.covel/plugins/observer
```

```text
✓ Static package validation: /Users/you/.covel/plugins/observer
  languages: text en; instructions en
```

这已经是一个完整的插件。没写的都由 Covel 推出来：ID 是文件夹名 `observer`；没有 `function` 块，所以它是一个由模型驱动的 agent，正文就是提示词；它每回合在故事之后运行。它不需要 `package.json`。

下面用脚手架生成一个更完整的起点：有面板、有函数、有测试用例。

## 2. 生成插件

```bash
pnpm create-plugin tavern-rumors
```

脚手架把插件写进用户插件目录，默认是 `~/.covel/plugins/tavern-rumors/`。它不需要安装任何依赖。输出的最后一行是：

```text
插件创建完成！路径：/Users/you/.covel/plugins/tavern-rumors
```

## 3. 看看生成了什么

```text
tavern-rumors/
├── PLUGIN.md                    包的版本和它贡献的面板
├── README.md
├── locales/
│   └── zh.yaml                  名称和界面文字的中文译文
├── runtimes/
│   ├── analyst/
│   │   └── RUNTIME.md           agent：读故事，决定要不要记一条
│   └── note/
│       ├── RUNTIME.md           函数：点按钮时手动记一条
│       ├── handler.js           这个函数的代码
│       └── ui/
│           └── panel.json       侧栏面板
└── tests/
    └── runtime-cases.json       离线运行用的测试用例
```

这个示例有两个 runtime，正好是两种类型：

| runtime   | 类型     | 什么时候运行               | 做什么                             |
| --------- | -------- | -------------------------- | ---------------------------------- |
| `analyst` | agent    | 每个回合的叙事之后，自动   | 读这一回合的故事，有新内容就记一条 |
| `note`    | function | 玩家点面板上的按钮时，手动 | 直接写入一条记录，不调用模型       |

两者都把记录写进这个插件自己的 `notes` 数据空间，面板把这个空间里的内容显示出来。

没有 `package.json`：插件的 ID 是文件夹名，版本写在 `PLUGIN.md` 里，`handler.js` 由 Covel 当作 ES module 加载。

打开 `runtimes/analyst/RUNTIME.md`，看开头的 YAML：

```yaml
schedule:
  stage: post-turn
io:
  inputs:
    narrator-output:
      from:
        contract: narrative-engine@1
      select: /narrativeOutput
      required: false
  selfData:
    - namespace: notes
      as: <existing-notes>
agent:
  tools:
    builtin:
      - plugin-data-set
```

| 这一段                                   | 意思                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 没有 `function` 块                       | 这是一个由模型驱动的 runtime，文件的正文就是给模型的提示词                                         |
| `schedule.stage: post-turn`              | 在叙事之后运行                                                                                     |
| `io.inputs.narrator-output`              | 读取本回合的故事正文。它来自“任何提供 `narrative-engine@1` 的插件”，而不是某个具体的插件           |
| `io.selfData`                            | 把自己已有的记录放进提示词，模型据此避免重复记录                                                   |
| 没写的字段                               | 用默认值：它用 `plugin` 这个模型用途，输出不是故事正文。见[默认值](../reference/plugins.md#默认值) |
| `agent.tools.builtin: [plugin-data-set]` | 模型只能调用这一个工具：往自己的数据空间写一条记录                                                 |

模型只能使用这里列出的工具。它不能读写别的插件的数据，也不能绕过内核直接改存档。

## 4. 校验

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

通过时输出：

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

第二行说明这个插件有英文和中文的界面文字，提示词是英文的。

校验只读文件，不运行你的代码。它检查配置里的字段、阶段、工具名和引用的文件。写错时它会指出是哪个文件的哪个字段。例如把 `stage: post-turn` 误写成 `stage: after-turn`：

```text
✗ [plugin-loader] invalid manifest frontmatter
.../tavern-rumors/runtimes/analyst/RUNTIME.md: schedule.stage: Invalid option: expected one of "setup"|"pre-turn"|"narrative"|"post-turn"|"audit"; correct this field using the current plugin manifest reference
```

## 5. 离线运行

不启动游戏、不调用真实模型，就可以运行插件：

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

它读取 `tests/runtime-cases.json` 里的用例，用预先写好的“模型回复”代替真实模型，然后检查结果。输出是一份 JSON，开头是：

```json
{
  "status": "ok",
  "mode": "mock",
  "pluginId": "tavern-rumors",
  "cases": [
    {
      "name": "manual-note-writes-plugin-data",
      "status": "passed",
```

两个用例都是 `"status": "passed"` 就说明：

- `note` 函数被调用后，`notes` 里多了一条记录。
- `analyst` 在模型调用 `plugin-data-set` 之后，记录被提交了。

> [!TIP]
> 这是开发时最快的反馈方式。每次改完清单或代码，先跑校验，再跑这一条，都通过了再进游戏。它不花模型费用。

## 6. 改成你自己的插件

现在把这个通用的示例改成“记录传闻”。改三处。

**插件的说明。** 打开 `PLUGIN.md`，把 `description` 改成：

```yaml
description: "Keeps a list of the rumors the player hears."
```

清单里的名称和说明用英文写。中文写在 `locales/zh.yaml` 里对应的位置：

```yaml
PLUGIN.md:
  description: "记下主角听到的每一条传闻。"
```

**agent 的目标。** 打开 `runtimes/analyst/RUNTIME.md`，找到正文里的 `## Plugin Goal` 一节，把占位的那句话换成：

```markdown
Record each rumor the player hears: who said it, and what it claims. A rumor is something a character reports second-hand, not something the player sees directly.
```

提示词用英文写。模型会按这一局游戏的语言输出，所以中文的游戏里记下来的传闻仍然是中文。

改完后再跑一遍第 4 步和第 5 步，确认仍然通过。

## 7. 在游戏里运行

启动 Covel：

```bash
pnpm dev
```

用户目录里的插件属于**社区插件**。它会被发现，但它的代码要等你在一局游戏里授权之后才会执行。

1. 打开 <http://localhost:5173>，选一个世界，点“进入”。
2. 在准备页展开“自定义插件与高级设置”，在插件列表里找到 `tavern-rumors` 并选中它。
3. 点“开始游戏”。出现“授权插件操作”时，授权 `tavern-rumors`。
4. 完成开场，然后写一个会让人开口说话的行动，例如“向掌柜打听最近镇上有什么怪事”。
5. 等“本轮已完成”出现。

现在打开右侧面板里的“插件记录”页签：

| 做什么                   | 应该看到                                             |
| ------------------------ | ---------------------------------------------------- |
| 看面板                   | 多了一条记录，内容是掌柜说的传闻                     |
| 点“添加记录”             | 立刻多出一条手动记录。这是 `note` 函数，没有调用模型 |
| 再玩一个没有人说话的回合 | 没有新记录。agent 判断没有新传闻，直接结束           |

到这里，你的插件已经在真实的游戏里读故事、调用工具、写入数据并显示出来了。

> [!NOTE]
> `pnpm dev` 会监视用户插件目录，你不用手动重启。改清单、界面文件或译文，插件会直接重新加载，授权保留。改已经运行过的代码文件（例如 `handler.js`），后端会自己重启一次，重启后要在游戏里重新授权。

## 没有按预期工作时

| 现象                     | 原因和处理                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 插件列表里没有它         | 它不在用户插件目录里，或者清单有错。运行第 4 步的校验，再重启一次后端                                                                    |
| 选中了但没有运行         | 没有授权。在游戏里处理“授权插件操作”的提示                                                                                               |
| 面板一直是空的           | 这一回合的故事里没有传闻，或者模型没有调用工具。在调试页面 <http://localhost:5173/debug> 查看 `tavern-rumors/analyst` 这一步的请求和回复 |
| 提示 `plugin` 用途不可用 | 在 **设置 → 模型 → 用途分配** 给它选一个模型，或者在准备页把这个任务改用别的用途                                                         |
| 离线运行报用例失败       | 你改了数据的形状，但没有同步修改 `tests/runtime-cases.json` 里的期望                                                                     |

## 你刚才用到了什么

| 概念         | 在这个插件里                                           |
| ------------ | ------------------------------------------------------ |
| 一个文件     | `observer` 只有一个 `PLUGIN.md`，其余由 Covel 推出     |
| 两种 runtime | `analyst` 是 agent，`note` 是函数                      |
| 阶段         | `analyst` 在 `post-turn` 自动运行                      |
| 按能力找插件 | 通过 `narrative-engine@1` 读故事，不点名具体的叙事插件 |
| 限定工具     | agent 只能调用 `plugin-data-set`                       |
| 自己的数据   | 两个 runtime 都只写自己的 `notes` 空间                 |
| 界面         | 用 `panel.json` 描述面板长什么样，不需要写前端代码     |
| 信任         | 社区插件的代码在玩家授权之后才执行                     |

## 接下来

- **改函数。** 打开 `runtimes/note/handler.js`，把记录的结构换成你需要的字段。
- **改面板。** 打开 `runtimes/note/ui/panel.json`，调整布局。可用的组件见[界面组件参考](../reference/ui-components.md)。
- **只想要一个提示词插件。** 见[零代码插件](./prompt-only.md)，那里的例子只有一个 `PLUGIN.md`。
- **写自己的工具。** 见[Agent 与本地代码](./local-code.md)。
- **发给别人用。** 见[验证与分发](../ship/index.md)。

全部字段见[插件字段参考](../reference/plugins.md)。
