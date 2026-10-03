# 提示词写法

插件的提示词正文（`PLUGIN.md` / `RUNTIME.md` 的正文和 `contributes.prompt` 固定段）是写给模型的指令。它用 English 写，并且每一种语言的会话都读它（简体中文会话读 `*.zh.md`，见 [i18n](../reference/i18n.md)）。读它的模型大小不一，母语也不是 English，所以正文分成两个区，写法不同。

## 两个区

**契约区**说明这个 runtime 读什么、做什么、交什么。模型不能读错它，所以用受控的 English 写：短句、一词一义、每条规则只说一次。

**文风区**是标题为 `Voice` 的一节，放语气、文体、创作方向和示例。这里随意写，下面的规则和检查都不管它。

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

契约区的小节按这个顺序出现，用不到的可以省略：开头一段说明职责（Purpose），然后 `Inputs`、`Procedure`、`Output`、`Limits`。

## 契约区的规则

| 规则                           | 说明                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 一句一条指令                   | 用祈使句和主动语态：`Call the tool one time.`，不写 `The tool should be called.`                                                     |
| 句子要短                       | 步骤（列表项）不超过 20 个词，说明性句子不超过 25 个词。更长就拆成两句。                                                             |
| 一词一义                       | 同一个东西始终用同一个词。术语取自 [glossary](../glossary.md) 的“提示词用词”表：写了 `turn` 就不要再写 `round`。                     |
| 每条规则只说一次               | 同一条规则写在三个地方，改的时候只会改到一处。需要强调就放进 `Limits`。                                                              |
| 用 `must` / `must not` / `can` | 不用 `should`：它没有说清是必须还是建议。                                                                                            |
| 不写含糊的限定语               | `as appropriate`、`if necessary`、`try to`、`etc.` 把判断留给了模型却没说怎么判断。写出条件：`If the narrative names the giver, …`。 |
| 标识符放在反引号里             | 工具名、字段名、枚举值、注入块的标签逐字拼写：`` `upsert-quests` ``、`` `runtime-inputs.worldIR.value` ``。                          |
| 不规定输出语言                 | 框架会在正文之后加上输出语言的指令。正文里写 `Respond in Chinese` 会和它冲突。                                                       |
| 不明显的规则带一句理由         | `Use the name on record. A second name makes a second quest.` 精确不等于只下命令：模型靠理由处理规则没列出的情况。                   |

不采用 ASD-STE100 的许可词表，只取它的句法约束。

## 检查

`pnpm check:prompts` 在通过或失败的结论之外，会列出契约区里违反上面规则的地方：

| 标记              | 含义                                     |
| ----------------- | ---------------------------------------- |
| `sentence-length` | 一句话超过 20 词（步骤）或 25 词（说明） |
| `should`          | 用了 `should`                            |
| `vague`           | 用了含糊的限定语                         |
| `repeated`        | 同一句话出现了两次                       |
| `output-language` | 规定了输出语言                           |

这些是**提醒，不会让检查失败**。规则是默认写法，个别句子可以有不遵守的理由（一条必须完整列出枚举值的步骤会超过 20 个词）。引号里的文字和反引号里的标识符不参与检查。

改了 English 正文之后，同步修改 `*.zh.md`，再运行 `pnpm prompts:lock`。中文变体用 [glossary](../glossary.md) 里的中文术语，保持和 English 一句对一句。

## 文风区怎么写

没有句法限制。几点经验：

- 给示例时写两三个风格不同的，避免模型照抄唯一的那个。
- 语气和文体的要求写成描述（“短句，动作在前，少用形容词”），不要写成硬性规则塞进契约区。
- 世界自己的文风写在世界包的 `WORLD.md` 里，不写进插件。
