# 仓库里的 agent 技能

这一页介绍 Covel 仓库 `.claude/skills/` 里的四个技能：每个是做什么的、怎样让你的编程助手用上它、怎样新加一个。它写给用 Claude Code、Codex 这类编程助手参与 Covel 开发的人。

技能（skill）是一份写给编程助手的操作说明。助手在遇到对应的任务时读它，然后照着做。它是纯文档：Covel 的后端不读取也不执行这个目录，游戏里的 agent 也用不到它。

## 现有的四个技能

| 技能                      | 做什么                                                           | 什么时候会用到                     |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `create-plugin`           | 新建或修改一个插件：清单、runtime、工具、界面面板，写完后校验    | 你说要做一个新插件、新玩法、新面板 |
| `create-world`            | 按你的设想生成一个世界包，写进 `worlds/` 并校验                  | 你说要做一个新世界、新设定         |
| `covel-static-turn-audit` | 只读代码，推演一个回合里各个 runtime 的调度会不会出错            | 只在你明确要求做这项审计时         |
| `covel-readonly-audit`    | 只靠阅读，对整个仓库做一遍检查，最后写成精简版、详细版和问题索引 | 只在你明确要求做这项审计时         |

后两个是很重的任务，会读大量代码。它们的说明里写明了“只在用户明确要求时使用”，助手不会自己启动。

### create-plugin

入口：[`.claude/skills/create-plugin/SKILL.md`](../../.claude/skills/create-plugin/SKILL.md)

它带着助手从一个玩法想法走到一个通过校验的插件。字段怎么写、工具怎么注册、怎样测试这些细节放在同目录的 `references/` 里，助手需要时才读。结果和读取接口以公开 SDK 的 `HandlerResult`、`FunctionStoreView` 为准；包内输入引用写完整的 `<pluginId>/<runtimeId>`。

官方的社区插件仓库另有一份适合独立开发插件的版本：[`.agents/skills/create-plugin`](https://github.com/covel-ai/covel-plugins/tree/main/.agents/skills/create-plugin)。那一份的示例和校验命令按社区仓库的目录结构写。

### create-world

入口：[`.claude/skills/create-world/SKILL.md`](../../.claude/skills/create-world/SKILL.md)

它自己不带字段表，也不带插件清单。它让助手先运行下面的命令，向当前版本问清楚“现在能写哪些内容”：

```bash
pnpm describe:authoring
```

写完之后用这条命令校验：

```bash
pnpm validate:world worlds/<id>
```

`references/` 里只留了两样：维度怎么写，以及发布前检查什么。

### covel-static-turn-audit

入口：[`.claude/skills/covel-static-turn-audit/SKILL.md`](../../.claude/skills/covel-static-turn-audit/SKILL.md)

它不启动应用，也不调用模型。做法是把每一次模型调用当作“结果未知”，列出一次 runtime 执行所有可能的结局，然后一层层往里推：先看各个插件的清单，再看插件之间的关系，再看内核怎样调度，最后看提交和后台任务。

- 每一条发现都是一条能在代码里逐行对上的反例。
- 光读代码判断不了的逻辑，它会写一个小脚本，喂输入看输出。脚本和日志留在 `debugs/audits/`。
- 报告写进 `devs/docs/audits/`。这两个目录都不进版本库。
- 你要求时，它另外生成一页 HTML 框图（`assets/audit-map.html`），用方块说明每部分代码做什么、彼此是什么关系。图表库从 CDN 加载；加载不到时，同样的内容以文字列出。

它不带回合流程的副本。框架承诺了什么，它去读[回合流程](./flow.md)；有哪些 runtime，它从当前的 `PLUGIN.md` 和 `RUNTIME.md` 里读。

### covel-readonly-audit

入口：[`.claude/skills/covel-readonly-audit/SKILL.md`](../../.claude/skills/covel-readonly-audit/SKILL.md)

它完全不运行任何东西：不改项目文件，不跑程序，不调用 Git，也不调用项目里的模型。

1. 默认只给出一份审计计划。你明确说“开始”之后，它才去读源码。
2. 先按专项一块一块通读：前端、后端、存储、模型网关、插件、世界包、内核、桌面端、媒体、挂起恢复与后台任务、安装与信任边界。
3. 再沿着跨越多层的关键路径，检查层与层之间接得对不对。
4. 每个专项和每条路径边读边记，最后在 `devs/docs/audits/<日期>-readonly-audit/` 里整理成三份文件。这个目录不进版本库。
   - `README.md`：精简版，先读它。写结论、先修的问题、修复顺序和要你决定的事。
   - `INDEX.md`：全部问题按严重程度排序，一行一条，带代码位置。修的时候按它挑。
   - `REPORT.md`：详细版，每条问题的完整证据都在这里。

各个专项分给子代理去读，默认最多同时跑 6 个。核对语言文件这类机械的对照交给便宜、快的模型，跨模块的逻辑交给最强的模型。规则见 [`references/dispatch.md`](../../.claude/skills/covel-readonly-audit/references/dispatch.md)。

和上一个技能的区别：这一个覆盖整个仓库，什么都不运行；上一个只看 runtime 的调度，可以用小脚本验证逻辑。

## 让助手用上技能

**用 Skills CLI 安装创作技能。** 先按[贡献指南](../CONTRIBUTING.md)准备 Covel 源码工作区和 Node.js / npx，再在工作区终端运行：

```bash
npx skills add ackness/covel --skill create-world --skill create-plugin
```

选择你使用的编程助手。命令只选择两份创作技能，不包含审计技能；安装后向助手描述世界或插件的构想即可。这些技能仍依赖 Covel 工作区里的作者查询与校验命令，安装技能不会安装框架本身。

需要先查看仓库里有哪些技能，可以运行：

```bash
npx skills add ackness/covel --list
```

当前会列出四份技能，包括 `create-world` 和 `create-plugin`。不想安装时，也可以打开上面的 `SKILL.md` 原文让助手读取。参数与安装范围见 [Skills CLI 文档](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)。

**Claude Code。** 它启动时会扫描两个位置的技能：

- `~/.claude/skills/<名字>/SKILL.md`：你个人的，所有项目可用。
- `<项目>/.claude/skills/<名字>/SKILL.md`：项目自带的。Covel 的四个技能在这里。

在 Covel 仓库里打开 Claude Code，直接说你要做什么（例如“帮我做一个记录传闻的插件”），它会根据技能的说明自己选用。想不出歧义，就点名技能：`/create-plugin`。

**其他助手。** 任何能读 Markdown 的助手都可以用。它不会自动发现这个目录时，让它先完整读一遍目标技能的 `SKILL.md`：

```bash
cat .claude/skills/create-plugin/SKILL.md
```

然后按里面的指引，需要时再读同目录的 `references/`。两点注意：

- 不要只读开头的几百行，也不要把整个 `references/` 一次全塞给助手。
- 每个技能目录里的 `agents/openai.yaml` 只是给界面显示用的名字和简介，不是执行入口。

## 一个技能的目录

```text
.claude/skills/
├── create-plugin/
│   ├── SKILL.md              入口。开头的 YAML 必须有 name 和 description
│   ├── agents/openai.yaml    给助手界面显示用的名字、简介和默认提示
│   └── references/           细节，助手需要时才读
├── create-world/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── references/
├── covel-static-turn-audit/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── assets/audit-map.html 框图页面的模板，助手只替换里面的数据
└── covel-readonly-audit/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── references/           审什么、关键路径、报告怎么写、怎么调度子代理
```

格式遵循 [agentskills.io](https://agentskills.io) 的规范。

## 新加一个技能

先判断它该不该是技能：

| 适合做成技能                           | 应该做进框架或插件            |
| -------------------------------------- | ----------------------------- |
| 开发者偶尔运行一次，用来生成或改造文件 | 玩家每个回合都会用到的功能    |
| 新建世界、新建插件、搭文档骨架         | 游戏循环、工具调用、状态管理  |
| 给开发者和作者用的模板                 | 给玩家和 runtime 用的内置工具 |

一句话：每个回合都要触发的能力是插件或内置工具；开发者偶尔跑一下的是技能。要做前者，见[插件开发要点](../plugins/essentials.md)。

确定是技能之后：

1. 新建 `.claude/skills/<名字>/SKILL.md`，按下面的模板写。
2. 细节放进 `.claude/skills/<名字>/references/`。
3. 新建 `agents/openai.yaml`，至少写 `interface.display_name`、`short_description` 和 `default_prompt`。
4. 检查 `SKILL.md` 开头的 YAML：有 `name` 和 `description`，并且 `name` 和目录名相同。仓库里没有自动检查这一条的工具。
5. 在这一页的表格和目录图里加上它，并更新根目录 `AGENTS.md` 的 Agent Skills 一节。
6. 提交 pull request。

```markdown
---
name: my-skill
description: 一句话说明这个技能做什么、什么时候该用
---

# 技能的标题

## 输入

用户会给出什么：一个想法、几个参数，或者上下文。

## 步骤

1. 第一步
2. 第二步
3. 第三步

## 验证

运行哪条命令确认结果是对的。

## References

- 需要字段细节时，读 `references/xxx.md`
- 需要例子时，读 `references/example-xxx.md`
```

### 写技能的八条规则

1. **开头的 YAML 只写标准字段。** 至少有 `name` 和 `description`。给界面看的信息写进 `agents/openai.yaml`。
2. **入口要短。** `SKILL.md` 控制在 50 到 150 行，让助手用最少的字知道这个技能做什么、流程是什么。
3. **细节放进 `references/`。** 助手只在需要时读它，所以那里可以写得很细，几百行也没问题。
4. **`description` 决定技能会不会被用上。** 助手靠它判断要不要用这个技能。写得越具体，选得越准。
5. **“什么时候用”写在 `description` 里。** 正文是选中之后才读的，写在正文里等于没写。只该在用户明确要求时运行的重型技能，也要在 `description` 里写明。
6. **不要抄字段表。** 字段、可选值、组件清单以[参考](../reference/index.md)里的页面为准，技能里只放链接。抄过来的表会悄悄过期，助手照着写就会出错。技能自己只记流程、能运行的校验命令和踩过的坑。
7. **向当前版本查，而不是把清单写死。** 会随插件增减而变的内容（能预置哪些数据、有哪些插件、有哪些设置项）由 `pnpm describe:authoring` 输出。技能里出现一个具体的插件 ID，就等于给以后每个新插件留了一处要手改的地方。
8. **示例要能通过校验。** 技能里的完整示例会在 CI 里按正式的规则校验（见 `apps/server/tests/lib/authoring-describe.test.ts`）。通不过的示例不能合入。

## 相关页面

- [与编程助手协作](../agent-workflow.md)：在这个仓库里用助手开发的整体流程。
- [第一个插件](../plugins/first-plugin.md)和[第一个世界](../worlds/first-world.md)：不用助手、自己动手的教程。
- [agentskills.io](https://agentskills.io)：技能格式的规范。
