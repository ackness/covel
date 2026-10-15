# Verify with a real model

This page explains how to use one command to play a few turns automatically on a running Covel server, and to check that each plugin runs as its configuration says. The command is `pnpm e2e:verify`. It does not open a browser. It works entirely through the server's interfaces. After reading this page, you should be able to run it, read its report, and know how to record a session and replay it again and again.

Use it when:

- You changed a plugin or a runtime, and want to confirm the whole flow still works.
- You changed trigger, stage, or cadence rules, and want to see how they are actually scheduled.
- You want to see how long a model's tool calls took and what they output.
- You are getting ready to release, and want to run a full pass on a real model.

First finish the validation and offline run in [Test a plugin](./test.md). Those two steps cost nothing. This step calls a real model.

## Before you start

1. The server is running: `pnpm dev:server`, or, when you use PostgreSQL, run `pnpm db:up` first and then `pnpm dev:pg`. The default address is `http://localhost:3001`.
2. The model config works. By default, the script does not change the models. Each runtime uses the model that the server config gives it, just as it does when a player is actually playing.
3. The server can get the keys for the model providers. Put them in `.env.llm`, or set them as environment variables of the server process. The script does not read keys itself.

The first time you run it in the repository:

```bash
cp .env.example .env
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
pnpm dev:server
```

Then open another terminal and run the script. The script does not start the server for you, and it does not create `llm.toml`.

> [!NOTE]
> The script does not handle "authorize plugin actions". It is suited to checking the built-in plugins under the repository's `plugins/` folder. Community plugins in the user plugin folder need authorization before they run. To check them in the game, follow [Package and try an install](./package.md).

## 1. Run a full pass

```bash
pnpm e2e:verify
```

By default, it plays 3 turns, using the first world that the server returns. The script does seven steps in order. Each step prints a heading and a table:

| Step | Name                  | What it does                                                                                                                             |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Health Check          | Confirms the server is online                                                                                                            |
| 2    | Plugin Flow Discovery | Asks the server for the list of all plugins and runtimes                                                                                 |
| 3    | World Selection       | Chooses the world                                                                                                                        |
| 4    | Session Creation      | Creates a session the way the session-prep screen does, and reads back which plugins this session actually enabled                       |
| 5    | Turn Execution        | Runs the opening, then creating a character, then N turns. Each turn is checked against expectations                                     |
| 6    | Final Session View    | Checks that the opening steps and background jobs have finished, lists the model each runtime actually used, and saves the debug records |
| 7    | Summary               | Summarizes and gives `PASS` or `FAIL`                                                                                                    |

The script has no plugin names written into it. It reads the plugin list from the server. So a new plugin that is fully configured and enabled in this session is checked automatically.

When it finishes, read the final summary and the exit code:

| Exit code | Meaning                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `0`       | All checks passed. The summary is `PASS`                                                                  |
| `1`       | At least one check failed: a runtime failed to run, it did not trigger as expected, or a tool call failed |
| `2`       | An environment problem: cannot reach the server, a timeout, or a response in the wrong format             |

## 2. Check one plugin only

```bash
pnpm e2e:verify --plugin guide --turns 2
```

`--plugin` and `--runtime` only limit the scope of the report and the checks. Other runtimes still run as usual, so the dependencies stay complete.

If the plugin you want to test is not enabled by default in this world, use `--enable-plugins` to add it to this session:

```bash
pnpm e2e:verify --enable-plugins memory --plugin memory
```

## 3. Read the report for each turn

For each run, the script prints four blocks:

| Block                     | Content                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Runtime Timeline          | The runtimes that ran in this run: stage, name, status, duration, and a summary of the output                       |
| Tool Calls                | Each tool call: which runtime, which tool, status, duration, whether it was authorized, and the start of its output |
| Trigger Verification      | For each runtime, compares "should it run?" with "did it actually run?"                                             |
| Detected interaction form | The forms that appeared in the opening stage, and how the script filled them in                                     |

The request that completes the last opening step also continues into the opening turn. So at that point, two executions are reported: first the opening, then the opening turn.

When a turn was not saved successfully (`execution.completed.committed` is `false`), that turn is marked `FAIL`.

### Results of the trigger checks

| Result  | Meaning                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`  | It should run, and it ran successfully                                                                                                                               |
| `DEFER` | This is a background runtime. The turn has ended, it continues in the background, and its result is checked in step 6                                                |
| `FAIL`  | A runtime that should run every turn did not run, or a runtime that should run failed                                                                                |
| `WAIT`  | A runtime that runs on an interval did not get its turn in this turn. Or an opening step has not been recorded as done yet (checked again in step 6)                 |
| `SKIP`  | It should not run in this turn: the plugin is not enabled, it does not belong to this stage, the turn is before its start turn, or it ran but decided to skip itself |
| `FIRE`  | A runtime triggered by an event or manually ran. This is for information only                                                                                        |
| `WARN`  | A runtime that should not have run did run. It is not a failure, but worth a look                                                                                    |

A runtime whose status is `skipped` is **not a failure**. It was scheduled, but its own guard decided not to do anything this time. Only `failed` gives `FAIL`.

### How the script decides "should it run?"

It works out the answer from the server's scheduling rules. It first passes three gates. If any gate fails, the result is `SKIP`:

1. **Enabled**: is the plugin among the plugins enabled for this session? If not, it never runs. The reason column says `plugin not in session active set`. Plugins that replace each other (two narrative plugins, several image engines) expect only the one that is enabled to run.
2. **Stage**: does the runtime declare a `stage`? One that does not (triggered by an event or manually, or only contributing content) does not take part in stage-based scheduling. When it is triggered itself, it is recorded as `FIRE`.
3. **Time period**: a runtime in the `setup` stage runs only at the opening. Runtimes in the other stages run only in the normal turns.

After it passes these three gates, it checks which turn this is. The opening and the player's first message both count as turn 1:

| Configuration                                                                             | Expectation                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTurn` is greater than the current turn, or `every` does not divide the current turn | This turn does not run (`SKIP`)                                                                                                                                                   |
| `auto`, with no `every`, no cooldown and no count limit                                   | It must run in every turn (strict `PASS` / `FAIL`)                                                                                                                                |
| `auto` with `every`, `cooldownTurns` or `maxTriggerCount`                                 | It must run at least once in the whole session. A turn that does not get its turn is marked `WAIT`, and step 7 checks them all together                                           |
| `schedule.detached: true`                                                                 | Marked `DEFER` in the turn. In step 6, it waits for background jobs to clear, and each job must succeed or be cancelled on purpose                                                |
| `stage: setup`                                                                            | Step 6 checks whether it is marked as completed in this session's records. Opening work may happen after the form is submitted, so it may not show up in the report for each turn |

### How the script fills in forms

When a form appears in the opening stage (creating a character, assigning points), the script fills it in and submits it automatically. It handles up to 3 forms:

- A number field uses its default value. If there is no default, it uses the minimum value.
- A point-buy form spreads the points across the number fields one by one, within the budget.
- To set specific values, use `--form-values '<json>'`.

## 4. Two checks that appear only in the debug records

Step 6 also checks two things from the debug records. You cannot see them in the saved turn results.

**Tool calls that were rejected and then retried.** When a model passes wrong parameters, the call is rejected, and the model calls it again. The turn result leaves no trace of this, so the `fail` count in the summary is always 0. The script lists these calls grouped by runtime, tool, and error, and shows `rejected-and-retried=N` on the summary line.

- Each one costs an extra round of model calls. A large number means there is a problem with the tool's parameter definition or its prompt.
- It counts only as a warning. A real model will have a few of these in every session.
- It is `FAIL` only when the number of rejected calls is greater than the number of successful ones.
- With `--strict-traces`, none are allowed at all.

**Language.**

- Output language: the script reads the free text in each runtime's replies and tool arguments, and checks whether it uses the language of this session. A session in a CJK language should not contain whole English sentences. A session in any other language should not contain CJK characters. When one runtime has 5 or more text items in the wrong language, and they make up more than a tenth of all its text, it is `FAIL`. A few stray items only count as a warning.
- Prompt language: in a session in a non-CJK language, the script counts the CJK characters that appear in the prompts and tool definitions sent to the model. It lists them by runtime, with one example for each. When the model reads Chinese, it tends to answer in Chinese, so this check shows where the Chinese came from. It is only a warning.

`--no-language-check` skips both checks. The character names and player lines that the script uses itself follow `--locale`, so they do not bring in another language.

## 5. Read the logs

Each run writes a few files by default under `debugs/e2e-logs/`. The file names start with `e2e-<date>-<time>`:

| File                               | Content                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `e2e-<ts>.log`                     | A full copy of the terminal output                               |
| `e2e-<ts>-<session>-turns.json`    | Raw data for each turn: runtimes, tool calls, and trigger checks |
| `e2e-<ts>-<session>-snapshot.json` | The state of this session as read in step 6                      |
| `e2e-<ts>-<session>-traces.json`   | The full debug records of this session                           |
| `e2e-<ts>-<session>-failures.json` | Details of the failed checks. Not written if nothing failed      |
| `e2e-<ts>-<session>-fatal.json`    | Error information when an unexpected error happens               |

The output is plain text: no emoji, no colors, and fixed column widths, so it is easy to compare and search. Even if an error happens partway through, what was already collected is still written.

After a pass, the script deletes this session. To keep it for inspection, add `--keep`. It is always kept when a check fails.

## All options

```bash
pnpm e2e:verify [options]
```

| Option                   | Default                                                  | Description                                                                                                                          |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--server <url>`         | `http://localhost:3001/api`                              | Address of the server interface                                                                                                      |
| `--slot <name>`          | Unchanged (or the environment variable `E2E_MODEL_SLOT`) | Makes the runtime that writes the story use this model role. The other runtimes stay the same. Write only the `xxx` in `[covel.xxx]` |
| `--world <id>`           | The first world the server returns                       | Which world to use                                                                                                                   |
| `--locale <tag>`         | `zh-CN`                                                  | The language of this session. It also decides which language's prompts are read                                                      |
| `--session-id <id>`      | Assigned by the server                                   | Creates the session with this ID. Replay needs it fixed. See [Recording and replay](#recording-and-replay)                           |
| `--turns <n>`            | `3`                                                      | How many turns to play after the character is created                                                                                |
| `--runtime <id>`         | None                                                     | The report and checks cover only this one runtime                                                                                    |
| `--plugin <id>`          | None                                                     | The report and checks cover only this one plugin                                                                                     |
| `--enable-plugins <ids>` | None                                                     | After the session is created and before the first turn, enables these plugins. Separate them with commas                             |
| `--core-only`            | None                                                     | Creates the session with only the core plugins. Does not load the plugins that the world presets                                     |
| `--player-message <str>` | A few built-in lines, used in rotation                   | The player input for each turn                                                                                                       |
| `--form-values <json>`   | Inferred from the field type                             | Values used when filling forms                                                                                                       |
| `--timeout <seconds>`    | `300`                                                    | The longest wait for each turn                                                                                                       |
| `--log-dir <path>`       | `debugs/e2e-logs`                                        | Where the logs are written                                                                                                           |
| `--no-log`               | None                                                     | Do not write log files                                                                                                               |
| `--verbose`              | None                                                     | Print every event received                                                                                                           |
| `--keep`                 | Kept only when a check fails                             | Keep this session even after a pass                                                                                                  |
| `--require-compaction`   | None                                                     | Fail if no history compression happened during the whole run                                                                         |
| `--require-summary-use`  | None                                                     | After compression, fail if no model call's prompt contains `<compacted_history>`                                                     |
| `--require-tools <ids>`  | None                                                     | Each listed tool must be called successfully at least once, or the run fails                                                         |
| `--strict-traces`        | None                                                     | Fail if the debug records contain any failed or errored model reply                                                                  |
| `--no-language-check`    | None                                                     | Skip the language check                                                                                                              |
| `--max-input-tokens <n>` | None                                                     | Checks that each input the provider reports is no larger than this number. Having no usage data at all also counts as a failure      |
| `--help` / `-h`          | None                                                     | Print help                                                                                                                           |

A few common combinations:

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

To compare Chinese and English prompts, use `--locale` together with the server's environment variable `COVEL_INSTRUCTION_LOCALE`.

## How configuration matches actual behavior

The biggest use of this script is to confirm that each runtime's actual behavior matches its configuration:

| Configuration                                           | How the script verifies it                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `schedule.stage: setup`                                 | Runs only at the opening. Step 6 checks that it is recorded as completed                    |
| `stage: pre-turn` / `narrative` / `post-turn` / `audit` | Runs only in normal turns                                                                   |
| `auto` (the default), with a `stage`                    | Must run in every turn                                                                      |
| `auto`, with a `stage` and `every`                      | Runs at least once in the turns that are allowed                                            |
| `schedule.detached: true`                               | Marked `DEFER` in the turn. Step 6 checks that the background job succeeded                 |
| No `stage`                                              | Not scheduled by stage. Marked `FIRE` when it is triggered itself                           |
| Plugin not enabled in this session                      | `SKIP` throughout                                                                           |
| `io.visibility: story`                                  | The output column of the Runtime Timeline shows `narrative(<character count>c)`             |
| `io.visibility: system` (the default)                   | The output column shows `keys=[...]`                                                        |
| `agent.loop.maxSteps: N`                                | When the steps run out, the failure record contains `exhausted the tool loop after N steps` |
| `agent.tools`, `contributes.tools`                      | The Tool Calls table shows the actual number of calls and the success rate                  |
| A `function` block (a function runtime)                 | It has no model-initiated calls in the Tool Calls table                                     |

## Recording and replay

Almost all of the time in a scripted session is spent waiting for the model. `pnpm llm:replay` puts a proxy in front of the model. On the first run, it records the answer to each request. After that, a request that is the same as before gets the recorded answer, and the model is not called again.

A reference number: a three-turn session in the `lantern-barrow` world makes 47 model calls. Recording took 229 seconds. On replay, all 47 calls were matched, and it took 4 seconds.

### Conditions for replay to work

The requests sent by the two runs must be **exactly the same**. If even one differs, the model writes new content, and every request after it changes too. So each run must meet these conditions:

1. **Fix the session's ID**: `--session-id <id>`.
2. **Set `COVEL_RANDOM_SEED` on the server**: the dice that plugins take from `ctx.random`, and the random part of IDs, are the same on every run. Numbers that a plugin takes directly from `node:crypto` or `Math.random` are not controlled by it.
3. **The ID does not exist yet at the start of each run**: the same ID cannot be created twice. The simplest approach is a new database file for each run. The script deletes the session after a pass, so you can also run again on the same server. When a run fails, or when `--keep` is used, the session is left behind, and you must delete it first.
4. **The world, plugins, prompts, language, and model config have not changed**. If you change any of them, the affected requests become new requests. This is also when you need to record again.

### Replay a recorded game in the repository

Each folder under `tests/llm-replay/` is one recorded session. The recordings are committed with the repository, so after you move to another machine, you can replay without a model, keys, or a network:

```bash
pnpm e2e:replay                  # replay every session
pnpm e2e:replay lantern-barrow   # replay one
```

A folder holds three things:

| File            | Content                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario.json` | The session: `world`, `turns`, `locale` (default `zh-CN`), `sessionId`, `seed`, and the other arguments `args` passed to the script                 |
| `llm.toml`      | The model used when recording. Each `[covel.<role>]` must set `provider` and `baseUrl`. At run time, `baseUrl` is replaced with the proxy's address |
| `recording/`    | One answer file for each request                                                                                                                    |

For each session, the command starts the proxy, a dedicated server, and the script in turn, and stops them all at the end.

- The dedicated server uses a new database in a temporary folder, its own `COVEL_HOME`, the random seed, and `TZ=UTC`. It does not read `.env` or `~/.covel`. It also does not inherit `COVEL_*`, `E2E_*`, `STORE_BACKEND`, or other variables from your terminal, or any provider keys. So two machines send the same requests.
- When replaying, every request must be in the recording. If one is not, it counts as a failure. A failed check in the script itself also counts as a failure.
- The script log, the server log, and the requests used for matching are written to `debugs/llm-replay/<game>/`.
- `--verbose` prints the script's output as it runs.

### Record or record again

Record again after you change the world, a plugin, a prompt, or `llm.toml`:

```bash
DEFAULT_BASE_URL=https://api.example.com   # origin of the endpoint, without /v1
DEFAULT_API_KEY=sk-...
pnpm e2e:replay --record lantern-barrow
```

- Recording is not tied to one provider. New requests go to the OpenAI-compatible endpoint that `DEFAULT_BASE_URL` points to. You can put these two variables in the environment, or in `.env.llm` in the repository root. A trailing `/v1` is removed. `--upstream <origin>` can switch to a different address for one run.
- The `llm.toml` of each recorded session in the repository uses `provider = "default"`, so the key is read from `DEFAULT_API_KEY`.
- The model is whichever one `llm.toml` names, and your endpoint must provide it. To change models, edit `llm.toml` and then record again.
- Requests that are already in the recording get their answer from it. Only new requests go to the model. So if you change only one plugin's prompt, recording again calls only the part that is affected.
- After the session finishes (the script exits with `0` or `1`), old answers in `recording/` that this run did not use are deleted. Nothing is deleted if the run stopped partway through.
- After you confirm the result, commit the changes in `recording/` together.

The recording file holds the original text of the model's answers. It does not contain keys or prompts. To check its size, use `du -sh tests/llm-replay/<game>/recording`. The prompts are in the `*.requests` files under `debugs/`. They are much larger than the answers, and they are not committed to the repository.

To add a new session: copy a folder, edit `scenario.json`, delete `recording/`, and then record it.

### Record and replay by hand

If you only want to run one session again and again on your own computer, without putting it in the repository, you can start the proxy, the server, and the script separately.

First prepare a model config that points every role you will use to the proxy. For example, `debugs/llm-replay/llm.toml` (`debugs/` is not committed to the repository). The examples below assume the real endpoint is at `127.0.0.1:3425`. Replace the provider name and model with your own:

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

**Recording.** Open three terminals and start them in order. The first is the proxy. `--upstream` is the address of the real endpoint, without `/v1`:

```bash
pnpm llm:replay --mode record --fixtures debugs/llm-replay/demo --upstream http://127.0.0.1:3425
```

The second is the server. The server still sends the key for each provider (here `LOCAL_API_KEY`), and the proxy passes it on to the real endpoint unchanged:

```bash
SERVER_PORT=3160 COVEL_RANDOM_SEED=20261006 \
  COVEL_LLM_TOML="$PWD/debugs/llm-replay/llm.toml" \
  SQLITE_PATH="$PWD/debugs/llm-replay/run-a/covel.db" \
  COVEL_LOGS_DIR="$PWD/debugs/llm-replay/run-a/logs" \
  LOCAL_API_KEY=your-key \
  pnpm --filter @covel/server exec tsx src/index.ts
```

The third is the script:

```bash
pnpm exec tsx scripts/e2e-plugin-verify.ts --server http://localhost:3160/api \
  --world lantern-barrow --turns 3 --session-id lantern-barrow-replay
```

When the session ends, stop the server, and then stop the proxy with Ctrl-C. When the proxy exits, it prints statistics, and it writes `debugs/llm-replay/demo.record.stats.json` and `debugs/llm-replay/demo.record.requests/`.

**Replay.** Switch the proxy to replay mode, point the server at a new database file, and keep the script command the same:

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

In the statistics, `none 200` under `served` is the number of requests answered from the recording. `proxy 200` is the number of requests forwarded to the real endpoint. Replay mode has no real endpoint. A request that was never recorded gets an error, and the matching runtime fails.

### When not every request matches

```bash
pnpm llm:replay:diff debugs/llm-replay/demo.record.requests debugs/llm-replay/demo.replay.requests
```

It lists the requests in the second run that are not in the first run. For each one, it shows where it starts to differ from the closest request in the first run. Look at the one with the lowest number first. The ones after it are usually caused by it.

To make the unmatched requests produce an answer you can look at, run the second run with `--mode record` too (also with `--upstream`), and add `--tag <name>`. Requests that were never recorded are forwarded to the real endpoint and recorded.

For `pnpm e2e:replay`, the requests from the two runs are in `debugs/llm-replay/<game>/record.requests` and `replay.requests`. If the recording was made on another machine, this machine has no `record.requests`. Record once on this machine first, and then replay and compare.

### How the proxy decides that two requests are "the same"

- It compares a digest of the whole request. Looking only at the last user message is not enough: after the story, several agents run, and their last user message is the same.
- Tool call IDs, UUIDs, timestamps, and session IDs that are not fixed do not take part in the comparison. This is a safety layer. Covel does not put these values into prompts in the first place. See [Plugin field reference · Input and output](../reference/plugins.md#inputs-and-outputs).
- A streamed answer is recorded together with its timing. On replay, the delays are shortened to one thousandth by default. `--speed 1` replays at the recorded pace.
- After the proxy restarts, it loads the existing recordings. This is true in record mode too.
- If, while recording, the model returned an error inside an otherwise successful stream, replay still gives an error for that request. So the server takes the same retry path as it did when recording.

### Current scope

- Full-session replay has been verified only on the three-turn `lantern-barrow` session. Longer sessions and other worlds may still have differences that are not handled. Use `pnpm llm:replay:diff` to find them.
- The differences caused by moving to another machine (repository path, `HOME`, time zone, `LANG`, and variables in the terminal) have been verified only on one session that stops at character creation.
- On replay, a model's answer changes from seconds to milliseconds. If the content of a prompt depends on "whether a background job or the next turn finishes first", the two runs may differ. That did not happen in the session above.
- The repository's CI does not run `pnpm e2e:replay`.

## When it does not work as expected

| Symptom                                                                           | Cause and what to do                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED`, or it fails at step 1                                             | The server is not running. The script does not start it. If you changed the port, use `--server http://localhost:<port>/api`                                                           |
| `preset not found`, or the role does not exist                                    | `--slot` takes only the `xxx` in `[covel.xxx]`. For `[covel.e2e_local]`, write `--slot e2e_local`                                                                                      |
| A model request returns 401                                                       | The server did not get the key. Check the provider settings in `.env.llm` and `llm.toml`                                                                                               |
| A plugin is `SKIP` throughout, with the reason `plugin not in session active set` | It is not enabled in this session. This is the correct result. To test it, add `--enable-plugins <id>`                                                                                 |
| `WARNING: SSE stream terminated prematurely` appears again and again              | The connection to the model dropped partway through. The script re-reads the turn records automatically. If every row in the Runtime Timeline is `success`, you can treat it as a pass |
| `rejected-and-retried` in the summary is large                                    | The model often passes wrong tool arguments. Check the tool's parameter descriptions and its prompt                                                                                    |
| The output language check fails                                                   | A runtime used the wrong language. First look at the source named in the "prompt language" item                                                                                        |
| You want to keep the evidence                                                     | Add `--keep` to keep the session. Use `--log-dir <path>` to change the log folder. Use `--verbose` to print every event                                                                |
| Some requests do not match during replay                                          | The requests from the two runs differ. Check [Conditions for replay to work](#conditions-for-replay-to-work), then use `pnpm llm:replay:diff` to find the first difference             |
| The model address is wrong when using the recording proxy                         | Change that role's `baseUrl` directly to the proxy's address                                                                                                                           |

## Next

- [Package and try an install](./package.md)
- Check the player flow in the browser: [Browser testing](../internals/e2e-testing.md#player-flow-acceptance-before-a-release)
- A short table of these commands: [Command reference](../internals/commands.md)
