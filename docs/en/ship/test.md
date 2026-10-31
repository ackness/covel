# Test your plugin

This page shows you how to test a plugin without opening the game and without spending model fees. It uses `tavern-rumors`, which you built in [your first plugin](../plugins/first-plugin.md).

Run all the commands from the root of the Covel repository.

## Three checks, from fastest to slowest

| Check            | What it can find                                                  | How long      |
| ---------------- | ----------------------------------------------------------------- | ------------- |
| Validation       | Configuration mistakes: a misspelled field, a missing file        | 1–2 seconds   |
| Offline run      | The plugin does not run: it is never triggered, data is not saved | A few seconds |
| Play in the game | The real model does not behave as you expected                    | A few minutes |

After each change, run the first two. When both pass, go into the game.

## 1. Validate

Players without a source checkout can click **Validate** in **Settings → Install & manage**.

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

Validation only reads the files. It does not run your code. When something is wrong, it says which field in which file has the problem.

## 2. Run offline

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

This command really runs your plugin. It only replaces the model with a fake one: what the model should say is written ahead of time in the test case.

The cases are in `tests/runtime-cases.json`. The scaffold already gives you two. Each case in the result has a status:

```json
"name": "analyst-records-one-note",
"status": "passed",
```

If every case is `passed`, the run passes. If one is `failed`, the command ends with a failure.

## 3. Add a case of your own

A case answers three questions: **what input the plugin gets, what the fake model answers, and what should come out at the end.**

Open `tests/runtime-cases.json`, and add an item to `cases`:

```json
{
  "name": "analyst-records-a-rumor",
  "runtimeId": "tavern-rumors/analyst",
  "message": "The innkeeper says the lighthouse keeper's daughter never left.",
  "llmResponses": [
    {
      "content": null,
      "finishReason": "tool_calls",
      "toolCalls": [
        {
          "id": "tc-1",
          "name": "notes-upsert",
          "arguments": "{\"record\":{\"id\":\"keepers-daughter\",\"kind\":\"analysis\",\"title\":\"The keeper's daughter\",\"text\":\"The innkeeper says she never left the lighthouse.\",\"tags\":[\"rumor\"]}}"
        },
        {
          "id": "tc-2",
          "name": "runtime-done",
          "arguments": "{\"reason\":\"recorded\"}"
        }
      ]
    }
  ],
  "expect": {
    "runtimeResults": [
      { "runtimeId": "tavern-rumors/analyst", "status": "success" }
    ],
    "pluginData": [
      { "namespace": "notes", "key": "keepers-daughter", "field": "title" }
    ]
  }
}
```

| This part      | What it means                                                                      |
| -------------- | ---------------------------------------------------------------------------------- |
| `runtimeId`    | Which runtime of the plugin to run                                                 |
| `message`      | The message the player sends in this turn                                          |
| `llmResponses` | The fake model's answer: which tools it calls, and what it passes to them          |
| `expect`       | What should be true after the run: the run succeeds, and this record is in `notes` |

Run step 2 again. The new case should be `passed`.

If the expectation and the result do not match, for example if you write a different name for `key` in `expect`, you see:

```json
"name": "analyst-records-a-rumor",
"status": "failed",
```

Scroll down. The result says which expectation was not met:

```json
{
  "status": "failed",
  "message": "pluginData:notes"
}
```

## When to add a case

- After you fix a problem. Add a case to make sure it does not come back.
- When the plugin gets content it should not handle. For example, if there is no rumor in this turn, it should record nothing.
- After you change the shape of the data. The expectations in the old cases must change to match.

## What this step cannot test

The offline run uses a fake model, so it cannot show two things:

- Whether the real model follows your prompt. To see this, play in the game.
- How the plugin behaves after installing, authorizing, and restarting. This is covered on [the next page](./package.md).

## Learn more

For unit tests of the tools and functions you write, and for the full way to write case files, see the [plugin testing reference](../plugins/testing.md).

## Next step

[Package and try an install](./package.md)
