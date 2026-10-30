# 提示词写法

这一页讲怎样写 agent 的提示词正文，让各种大小的模型都不容易读错。它适用于 `PLUGIN.md` / `RUNTIME.md` 的正文，以及 `contributes.prompt` 里的固定片段。读完之后，你能把一段提示词整理成“模型必须读对的部分”和“可以自由发挥的部分”。

先知道两件事：

- 提示词用英文写。所有语言的游戏都读它；简体中文的游戏读 `*.zh.md`，见[多语言参考](../reference/i18n.md)。
- 读它的模型有大有小，很多模型的母语也不是英文。所以越简单越好。

## 把正文分成两个区

**契约区**说明这个 runtime 读什么、做什么、交出什么。模型不能读错这一部分，所以用受约束的英文写：短句、一个词只表示一个意思、每条规则只说一次。

**文风区**是标题为 `Voice` 的一节，放语气、文体、创作方向和示例。这里可以随意写，下面的规则和检查都不管它。

一个完整的例子：

```markdown
You are the quest log of this session. You record the quests that the story gives the player.

## Inputs

`runtime-inputs.worldIR.value` holds the facts of this turn. `<existing-quests>` lists the quests on record.

## Procedure

1. Find each quest that this turn gives, advances, completes or fails.
2. Call `upsert-quests` one time with all of them.
3. If no quest changed, call `runtime-done`.

## Limits

- You must not add a quest that the narrative did not state.
- You must use the name on record for a quest that exists. A second name makes a second quest.

## Voice

Quest names are short and concrete, the way a player would write them in a notebook…
```

契约区的小节按这个顺序写，用不到的可以省略：

| 小节           | 写什么                 |
| -------------- | ---------------------- |
| 开头的一段     | 这个 runtime 的职责    |
| `## Inputs`    | 它读到什么，各自叫什么 |
| `## Procedure` | 一步一步做什么         |
| `## Output`    | 交出什么，什么形状     |
| `## Limits`    | 不能做什么             |

## 契约区的规则

| 规则                           | 怎样做                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一句一条指令                   | 用祈使句和主动语态。写 `Call the tool one time.`，不写 `The tool should be called.`                                                                                 |
| 句子要短                       | 步骤（列表项）不超过 20 个词，说明性的句子不超过 25 个词。更长就拆成两句                                                                                            |
| 一个词一个意思                 | 同一个东西始终用同一个词：写了 `turn` 就不要再写 `round`。用词取自[术语表的 Prompt vocabulary](../reference/glossary.md#prompt-vocabulary)                          |
| 每条规则只说一次               | 同一条规则写在三个地方，以后改的时候只会改到一处。需要强调就放进 `Limits`                                                                                           |
| 用 `must` / `must not` / `can` | 不用 `should`：它没有说清是必须还是建议                                                                                                                             |
| 不写含糊的限定语               | `as appropriate`、`if necessary`、`try to`、`etc.` 把判断交给了模型，却没说怎么判断。把条件写出来：`If the narrative names the giver, …`                            |
| 标识符放在反引号里             | 工具名、字段名、枚举值、数据块的标签要逐字拼写：`` `upsert-quests` ``、`` `runtime-inputs.worldIR.value` ``                                                         |
| 不规定输出语言                 | Covel 已经在提示词里加了“用什么语言输出”的指令。正文里再写 `Respond in Chinese` 会和它冲突                                                                          |
| 不把记账用的字段交给模型       | 会话 ID、UUID、时间戳对模型没有用，还会让同一段提示词每次都不一样。Covel 放进提示词的内容已经去掉了它们；自己拼文字时用 `modelFacingJson`。说“哪一回合”时用回合序号 |
| 不明显的规则带一句理由         | `Use the name on record. A second name makes a second quest.` 模型靠理由处理规则没有列出的情况                                                                      |

> [!TIP]
> 改写一句话时问自己：一个只会基础英文的人，能不能只读这一句就知道该做什么？

## 文风区怎么写

没有句法上的限制。几点经验：

- 给示例时写两三个风格不同的。只给一个，模型会照抄。
- 语气和文体的要求写成描述，例如“短句，动作在前，少用形容词”。不要把它们写成硬规则塞进契约区。
- 世界自己的文风写在世界包的 `WORLD.md` 里，不写进插件。

## 检查

仓库里的插件（`plugins/` 和 `templates/`）可以用一条命令检查：

```bash
pnpm check:prompts
```

它检查每个提示词的英文版和中文版是否同步，并列出契约区里不符合上面规则的地方。输出类似这样：

```text
[prompt-variants] 1 style warning(s):
  - plugins/char-creator/runtimes/character-tracker/RUNTIME.md:11: [sentence-length] 22 words in one step (at most 20): "In a large cast a description is shortened (it ends with COD…"
[prompt-variants] 15 pairs are in sync
```

方括号里的标记说明是哪一条规则：

| 标记              | 意思                                         |
| ----------------- | -------------------------------------------- |
| `sentence-length` | 一句话超过 20 个词（步骤）或 25 个词（说明） |
| `should`          | 用了 `should`                                |
| `vague`           | 用了含糊的限定语                             |
| `repeated`        | 同一句话出现了两次                           |
| `output-language` | 规定了输出语言                               |

这些是**提醒，不会让检查失败**。规则是默认的写法，个别句子可以有不遵守的理由：一条必须完整列出所有枚举值的步骤，就会超过 20 个词。引号里的文字和反引号里的标识符不参与检查。

> [!NOTE]
> 这条命令不检查用户插件目录里的插件。写社区插件时，对照上面的表自己过一遍。

## 改完英文之后

有中文版（`*.zh.md`）的提示词，两份要一起改：

1. 改英文正文。
2. 同步修改 `*.zh.md`。沿用术语表里的中文术语，完整保留规则、限制、工具名和示例含义，按中文习惯表达。
3. 仓库内置的插件再运行 `pnpm prompts:lock`，记下这一对文件已经同步。

只改了一边时，`pnpm check:prompts` 会失败。

## 常见的问题

| 现象                         | 多半是因为                                                 |
| ---------------------------- | ---------------------------------------------------------- |
| 模型有时调用工具，有时不调用 | 步骤里用了 `should` 或 `try to`。改成 `must`，或者写出条件 |
| 模型把同一个东西记成了两条   | 没告诉它沿用已有的名字，或者正文里同一个东西用了两个词     |
| 模型用错了语言               | 正文里规定了输出语言，和 Covel 的指令冲突。删掉那一句      |
| 小模型漏掉了某条规则         | 那条规则埋在一个长句里。拆开，一句一条                     |
| 模型照抄了示例               | 只给了一个示例。再加一两个风格不同的                       |
| 中文的游戏里，修改没有生效   | 只改了英文正文，没有改 `*.zh.md`                           |

## 接下来

- 提示词里能引用哪些内容：[只有提示词的插件](./prompt-only.md#提示词里能引用什么)
- 提示词最后是怎样拼起来的：[提示词结构](../reference/prompt-structure.md)
- 在真实模型上看效果：[用真实模型验证](../ship/real-model.md)
