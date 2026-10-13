# Prompt style

This page explains how to write the body of an agent's prompt so that models of any size are unlikely to misread it. It applies to the body of `PLUGIN.md` / `RUNTIME.md`, and to the fixed fragments in `contributes.prompt`. After you read it, you can organize a prompt into "the parts the model must read correctly" and "the parts it can use its own judgment on".

Two things to know first:

- Prompts are written in English. Games in every language read them. A game in Simplified Chinese reads `*.zh.md`. See [multilingual reference](../reference/i18n.md).
- The models that read them vary in size, and many of them do not have English as their first language. So the simpler the better.

## Split the body into two zones

The **contract zone** says what this runtime reads, what it does, and what it hands back. The model must not misread this part, so write it in constrained English: short sentences, one meaning per word, and each rule stated only once.

The **voice zone** is the section titled `Voice`. It holds tone, style, creative direction, and examples. You can write freely here. The rules and checks below do not apply to it.

A complete example:

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

Sections of the contract zone are written in this order. Leave out any that you do not need:

| Section           | What to write                                |
| ----------------- | -------------------------------------------- |
| Opening paragraph | The job of this runtime                      |
| `## Inputs`       | What it reads, and what each input is called |
| `## Procedure`    | What to do, step by step                     |
| `## Output`       | What to hand back, and its shape             |
| `## Limits`       | What it must not do                          |

## Rules for the contract zone

| Rule                                         | How to do it                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One instruction per sentence                 | Use the imperative mood and the active voice. Write `Call the tool one time.`, not `The tool should be called.`                                                                                                                                                                          |
| Keep sentences short                         | A step (a list item) is at most 20 words. An explanatory sentence is at most 25 words. If it is longer, split it into two sentences                                                                                                                                                      |
| One word, one meaning                        | Always use the same word for the same thing. If you wrote `turn`, do not write `round` later. Take the words from the [Prompt vocabulary in the glossary](../reference/glossary.md#prompt-vocabulary)                                                                                    |
| State each rule only once                    | A rule written in three places will be changed in only one of them later. If you need to stress a rule, put it in `Limits`                                                                                                                                                               |
| Use `must` / `must not` / `can`              | Do not use `should`. It does not say whether something is required or only advised                                                                                                                                                                                                       |
| Do not write vague qualifiers                | `as appropriate`, `if necessary`, `try to`, and `etc.` hand the judgment to the model without saying how to judge. Write the condition out: `If the narrative names the giver, …`                                                                                                        |
| Put identifiers in backticks                 | Tool names, field names, enum values, and data block labels must be spelled exactly: `` `upsert-quests` ``, `` `runtime-inputs.worldIR.value` ``                                                                                                                                         |
| Do not set the output language               | Covel already adds an instruction about which language to answer in. Writing `Respond in Chinese` in the body conflicts with it                                                                                                                                                          |
| Do not give the model bookkeeping fields     | Session IDs, UUIDs, and timestamps are of no use to the model. They also make the same prompt different each time. The content Covel puts into prompts already leaves them out. When you build text yourself, use `modelFacingJson`. When you refer to "which turn", use the turn number |
| Give a reason for a rule that is not obvious | `Use the name on record. A second name makes a second quest.` The model uses the reason to handle cases the rules do not list                                                                                                                                                            |

> [!TIP]
> When you rewrite a sentence, ask yourself: could someone who knows only basic English tell what to do from this one sentence alone?

## How to write the voice zone

There are no syntax limits here. A few tips:

- When you give examples, write two or three in different styles. If you give only one, the model will copy it.
- Write requirements for tone and style as descriptions, for example "short sentences, action first, few adjectives". Do not turn them into hard rules in the contract zone.
- Write the world's own writing style in the world package's `WORLD.md`, not in the plugin.

## Check

The plugins in the repository (`plugins/` and `templates/`) can be checked with one command:

```bash
pnpm check:prompts
```

It checks whether the English and Chinese versions of each prompt are in sync, and it lists the places in the contract zone that do not follow the rules above. The output looks like this:

```text
[prompt-variants] 1 style warning(s):
  - plugins/char-creator/runtimes/character-tracker/RUNTIME.md:11: [sentence-length] 22 words in one step (at most 20): "In a large cast a description is shortened (it ends with COD…"
[prompt-variants] 15 pairs are in sync
```

The tag in square brackets says which rule it is:

| Tag               | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `sentence-length` | A sentence is over 20 words (a step) or 25 words (an explanation) |
| `should`          | `should` is used                                                  |
| `vague`           | A vague qualifier is used                                         |
| `repeated`        | The same sentence appears twice                                   |
| `output-language` | An output language is set                                         |

These are **reminders, and they do not make the check fail**. The rules are the default way to write. A single sentence can have a good reason to break one: for example, a step that must list every enum value in full will go over 20 words. Text in quotation marks and identifiers in backticks are not checked.

> [!NOTE]
> This command does not check plugins in the user plugin directory. When you write a community plugin, go through it yourself against the table above.

## After you change the English

For a prompt that has a Chinese version (`*.zh.md`), change both files together:

1. Change the English body.
2. Change `*.zh.md` to match. Use the Chinese terms from the glossary, and keep one Chinese sentence for each English sentence.
3. For the plugins built into the repository, run `pnpm prompts:lock` again to record that this pair is in sync.

If you change only one side, `pnpm check:prompts` fails.

## Common problems

| Symptom                                                   | Most likely cause                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The model sometimes calls the tool and sometimes does not | A step uses `should` or `try to`. Change it to `must`, or write out the condition                |
| The model records one thing as two entries                | You did not tell it to reuse the existing name, or the body uses two words for the same thing    |
| The model uses the wrong language                         | The body sets an output language, which conflicts with Covel's instruction. Delete that sentence |
| A small model misses one rule                             | That rule is buried in a long sentence. Split it up, one rule per sentence                       |
| The model copies the example                              | You gave only one example. Add one or two more in different styles                               |
| In a Chinese game, a change has no effect                 | You changed only the English body and not `*.zh.md`                                              |

## Next steps

- What a prompt can reference: [plugins that are only prompts](./prompt-only.md#what-you-can-refer-to-in-a-prompt)
- How a prompt is finally assembled: [prompt structure](../reference/prompt-structure.md)
- See the effect on a real model: [verify with a real model](../ship/real-model.md)
