# World time

World time is the time inside the story: what day it is, what hour, or which part of the day the story is in. This page explains how world authors define their own calendar and how time moves, and how plugins read the clock.

World authors should read the Definition section. Plugin authors should also read the Runtime and state section.

World time has nothing to do with the two other kinds of "time":

- **Player turn count**: the turns the framework counts. If story time goes backward, the turn count does not go backward. Memory retrieval and audit still follow the order of the turns.
- **Real time**: the timestamps of the real world.

## Definition

A world package declares its time in one file. Put it at `data/time.yaml`, and it is read automatically.

```yaml
id: world
definition:
  kind: calendar
  name: 学园时间
  calendar:
    era: 学园历
    months:
      - { name: 春月, days: 30 }
      - { name: 夏月, days: 31 }
    hoursPerDay: 24
    minutesPerHour: 60
    periods:
      - { startHour: 0, name: 深夜 }
      - { startHour: 6, name: 早晨 }
      - { startHour: 12, name: 午后 }
      - { startHour: 18, name: 晚间 }
  initial: { year: 1, month: 1, day: 8, hour: 8, minute: 20 }
  evolution:
    mode: forward
    defaultStep: 5
    maxStep: 1440
    prompt: 对话通常几分钟，睡眠或明确的次日转场应跨日。回忆不改变当前日期。
```

The content of the file is `{ id: world, definition: ... }`. `id` is always written as `world`, and `definition` is the definition of the time.

When a world uses a descriptor (`data/world.data.yaml`), list this file in it:

```yaml
schemaVersion: 1
sources:
  timeDefinition:
    kind: yaml
    path: data/time.yaml
    schema: contract:world.time-definition@1
    to: contract:world.time-definition@1
    key: id
```

> [!NOTE]
> Time is not a world dimension. Writing `time` in `dimensions` is not accepted. Use the data file above instead. After you make this change, a development world that existed before has to be created again.

### Two time models

Choose one `kind`:

- `calendar`: a calendar with years, months, days, and clock hours.
- `phases`: only a few phases that repeat in order, with no exact clock hours.

| Field            | `calendar`                                                                            | `phases`                                                         |
| ---------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `name`           | The name of the time. Supports i18n                                                   | Same as left                                                     |
| Definition       | `calendar.era`; `months: [{name, days}]`; `hoursPerDay`; `minutesPerHour`             | `phases`: the phase names in order; `cycleLabel`: the cycle name |
| Optional periods | `calendar.periods: [{name, startHour}]`, where the start hours must strictly increase | No exact clock hours, so there is nothing extra to define        |
| Initial value    | `initial: {year, month, day, hour, minute}`; months and days start at 1               | `initial: {cycle, phase}`; the phase starts at 0                 |
| Base unit        | One minute of this calendar                                                           | One phase                                                        |
| Tool units       | `minute`, `hour`, `day`                                                               | `phase`, `cycle`                                                 |

The "base unit" is the smallest step of this clock. The step sizes in `evolution` below are counted in it.

Notes:

- **Weekdays**: `calendar.weekdays` can define the name of each day in a week. The names and the number of days are up to you. You can also use `initial.weekday` (starting at 0) to say which weekday the game starts on. When time moves across days forward or backward, the weekday is calculated along with it, and it does not depend on the real-world calendar.
- Each month can have a different number of days. Years, days, and clock hours are converted using integers, so moving time backward across a year boundary is fine.
- There are no real-world leap years, time zones, or astronomical conversions here.
- For a coarse calendar like the twelve Chinese double-hours, you can write twelve `phases` directly, and you do not need to pretend they are minutes.

### How time moves (`evolution`)

| Field         | Description                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`        | Must be written out. `forward`, `backward` (time goes back), `bidirectional` (the narrative decides the direction), or `random` (jumps at random within a range)                         |
| `defaultStep` | How many base units to move when the story text does not say how long something took. Suggested value. It can be 0                                                                       |
| `maxStep`     | The most base units that can move in one turn (in either direction). This is the limit the tools check strictly                                                                          |
| `prompt`      | The timing instructions that the author gives the model. It can be translated. For example, how long a conversation, sleep, or trip takes, and whether a memory affects the current time |
| `randomRange` | `{min, max}`. Required in `random` mode. A closed range with signs, in base units. The absolute value cannot exceed `maxStep`                                                            |

In `random` mode, the plugin draws the step through `ctx.random`. The model does not generate random numbers. With a fixed `COVEL_RANDOM_SEED`, the same script repeats its draw sequence regardless of session or turn IDs. Repeated tool calls in one turn reuse the buffered or saved result without drawing again.

An example of a coarse backward time:

```yaml
id: world
definition:
  kind: phases
  name: 梦境时间
  cycleLabel: 梦回
  phases: [黎明, 白昼, 黄昏, 深夜]
  initial: { cycle: 3, phase: 2 }
  evolution:
    mode: backward
    defaultStep: 1
    maxStep: 4
    prompt: 每轮向更早的梦境阶段移动；同一瞬间的连续对话可保持时间不变。
```

If you replace `evolution` with the following, time jumps forward or backward at random:

```yaml
evolution:
  mode: random
  defaultStep: 1
  maxStep: 4
  randomRange: { min: -4, max: 4 }
  prompt: 时间可能前进、停滞或倒流；人物保留经历，环境遵循新的阶段。
```

### A world that does not declare time

A world with no `data/time.yaml` uses a generic world calendar:

- 12 months, 30 days each. Each day has 24 hours, and each hour has 60 minutes.
- It starts at year 1, January 1, 08:00.
- By default, each turn moves forward 10 minutes.

It is not the Gregorian calendar.

### Built-in worlds you can use as references

| World                   | Model      | What to look at                             |
| ----------------------- | ---------- | ------------------------------------------- |
| `worlds/haruka-academy` | `calendar` | Twelve months, weekdays, four periods a day |
| `worlds/emberback`      | `calendar` | Works with a countdown dimension            |
| `worlds/mistport`       | `phases`   | Uses the tides for its phases               |
| `worlds/lantern-barrow` | `phases`   | Phases for dungeon exploration              |

### For plugin authors and tool developers

- The time definition is a public data contract, `world.time-definition@1`. The built-in `world-time` plugin owns the definition's schema, the calendar, and the advance logic. The framework only handles the general parts: importing data, arranging the run order, and passing inputs and transactions.
- Other plugins can receive world data through the same contract. They do not need to use the plugin ID or namespace of `world-time`.
- After import, the definition is written to `definitions/world` of the receiving plugin.
- The JSON Schema is at `plugins/world-time/schemas/time-definition.schema.json`. It is generated by `schema.js` in the same directory.
- The shape of the fields is checked at import. Constraints that span fields, such as `defaultStep` not exceeding `maxStep`, are checked by the plugin when it uses the definition.
- When an AI generates a world, the generator does not carry its own time schema. It uses the public data schema that the caller provides. It produces `{ contract, key, value }` in `WORLD_PACKAGE_YAML.contractData`, where `key` matches `value.id`. When saved as a file, it is written as a data file. When it is only stored in the database or only returned as a result, it is saved in `metadata.contractData`. After the browser syncs, the same import check still runs, and the same rules find the receiving plugin.

## Runtime and state

The built-in `world-time` is a core plugin, and it has two runtimes:

1. **`world-time/context`** (runs at the start of a turn, does not call a model): reads the clock of this game. If there is no clock yet, it reads the initial value from the world definition. It publishes the result as the contract `world-time-context@1`. The initial value and the display text in each language are saved through a proposal.
   - For a world that has an imported definition, the panel shows the rules before the first narrative.
   - When there is no imported definition, the panel shows the description of the default calendar.
2. **`world-time/advance`** (runs after the narrative, calls a model): reads the successful narrative of this turn and the start of the time, and then calls the tool `advance-world-time`.
   - The model only proposes "how long to move and in which direction". The plugin does the calendar arithmetic and the rule checks.
   - The unit comes from `currentTime.value.units`.
   - When the duration is 0, any unit is accepted, because a zero duration does not depend on the unit.
   - When the duration is not 0 but a unit that this clock does not have is used, the call is rejected. The error message lists the units that are available.
   - The run ends as soon as the tool succeeds. The default budget of 20 steps for the tool, the timeout, and loop detection still apply.

### The clock at the end of the turn

The output of `world-time/advance` is the public contract `world-time-evolution@1`. It is the clock **after** this turn is settled. It and `world-time-context@1` above are two moments of the same clock:

| Contract                 | Moment                 |
| ------------------------ | ---------------------- |
| `world-time-context@1`   | The start of this turn |
| `world-time-evolution@1` | The end of this turn   |

The output contains the settled `definition`, `tick`, `display`, `lastDelta`, and `reason`, plus a `summary` made for other runtimes to read:

| `summary` field     | Meaning                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `display`           | The settled time display text, already resolved to the session's content language                                             |
| `unit`              | The base unit used by both counts: `minute` for calendar, `phase` for phases                                                  |
| `elapsedSinceStart` | The current tick minus the world definition's `initial`. In other words, the number of base units since the start of the game |
| `elapsedThisTurn`   | The number of base units moved in this turn (that is, `lastDelta`). When time goes backward, both counts can be negative      |

A runtime that needs to keep records based on "the time at the end of this turn" (it runs after the narrative) reads it with an optional input:

```yaml
io:
  inputs:
    worldTime:
      from: { contract: world-time-evolution@1 }
      select: /summary
      required: false
```

- The `optional` list in the root `PLUGIN.md` must include `world-time-evolution@1`.
- This input also decides the order. The runtime that reads it runs after the time is settled, so it reads the value for this turn.
- If you read with `scope: committed`, or read `world-time-context@1` at the start of the turn, you get the value from the end of the previous turn.
- When the time is not settled, this input does not exist, and the runtime that reads it still runs as usual. This happens in two cases: the model call fails, or this is a recursive sub-narrative whose time is settled by the outer layer (in that case the output only has `reason`).

The built-in `world-init/dimension-tracker` and `world-init/dimension-clock` read the clock this way. The first one has the model follow the time settlement rules. The second one does not call a model. It calculates the dimension fields that the world declares as `x-derive` (countdowns, phases) from `elapsedSinceStart`. See [dynamic world dimensions](./dynamic-dimensions.md#fields-derived-from-the-clock).

### How the narrative reads time

A narrative plugin connects to time like this in its `RUNTIME.md`:

```yaml
io:
  inputs:
    worldTime:
      from: { contract: world-time-context@1 }
      required: false
```

`worldTime.value` is the **start** of this turn. It contains:

- `definition`: the time definition;
- `tick`: the integer tick;
- `display`: the display text;
- `units`: the time units this clock has. For calendar these are `minute` / `hour` / `day`. For phases they are `phase` / `cycle`. The first one is the base unit;
- For calendar, the year, month, day, hour, and minute. For phases, `cycle` / `phase`.

The narrative is written according to the world's `prompt`. It states clearly how long something took and whether there is a transition. The end time is settled after the turn ends. Old memories and earlier narratives must not override this start. A `scene` memory only describes the mood. The current date and time are kept by the clock.

### Where the clock is stored

- The clock is saved in the plugin's single data item `clock/current`. Like ordinary session data, it goes into snapshots, save points, and branches.
- The definition is copied into the session the first time it is saved. Later edits to the world or a new import of the definition do not reset an existing clock. Loading a save also does not reinterpret old ticks just because the world file changed.
- `lastTurnId` prevents the tool from being called twice in the same turn. `lastDelta` and `reason` record this change.
- All writes go through proposals. If the narrative fails or the save fails, the time is rolled back together with it.
- A recursive sub-narrative does not settle the time on its own.

### The `/time` command

When the player types `/time`, it calls the command `world-time:time` that the plugin declares, and it shows the clock that is currently saved.

- It displays using the session's language and the time definition saved in the save. It does not read world start values that were changed later.
- It does not call a model, does not generate narrative, does not advance the player turn, and does not advance the clock. In random mode, it does not draw a new random value either.
- When there is no clock record yet, it returns a clear message. The command itself does not initialize the clock.
- The RPC returns `{ ok, message, data }`. `data.initialized` tells "no record yet" apart from "a record exists". When a record exists, it also contains the structured clock and the most recent change.
- The discovery, parameter validation, and audit of the command are the same as for other plugin commands.

### Failures and limits

- When the model cannot give a duration, the clock stays at the start, and the runtime is reported as failed. It does not treat the default step as "a duration confirmed from the story". Regeneration and manual recovery follow the framework's general runtime recovery method.
- The stage's `timeOfDay` (day / night) does not switch automatically based on the world time. Tides, dreams, or backward phases may not map onto day and night. A display plugin can use it only after the world gives an explicit rule for the mapping.
