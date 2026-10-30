# Dynamic World Dimensions

A dimension is a piece of world data that is recorded and can change, such as study progress, reputation, or a countdown. This page covers the whole life of a dimension in one game: how it is declared, how it is validated, how it is read and updated each turn, and how it recovers when an update fails.

World authors need the first two sections (declaring a dimension, and fields that are calculated from the clock). The later sections are for people who write plugins and troubleshoot problems.

This page is an overview. The full rules for each part are on these pages:

| What you want to look up                             | Page                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| How to write it in a world package, and how it syncs | [Author declarations and sync](./world-data.md#dynamic-world-dimensions-dimensions)     |
| Values and settlement state in a session             | [Session snapshot and settlement](./world-model.md#dynamic-dimension-snapshot)          |
| How a plugin becomes the responsible party           | [Extension points](./extension-points.md#session-world-context)                         |
| Notification events                                  | [Protocol](./protocol.md#session-dimension-events)                                      |
| The API for player edits and recovery                | [Edit and recovery API](./api.md#dimension-editing-and-recovery-of-pending-settlements) |

Keep two things in mind:

- The **declaration** in the world package and the **current value** in a session are two separate pieces of data. If the current value cannot be read, the server does not fall back to the initial value in the declaration.
- The author chooses the dimension ID. The nine common kinds of world material (geography, factions, and so on) are only templates in the editor. They are not a list of allowed IDs.

```yaml
dimensions:
  study:
    name: 学习进度
    schema: { type: integer, minimum: 0 }
    initialValue: 0
    updateRule: 本轮明确完成一次学习时加一；承诺、回忆和未完成的学习不计入。
```

## Declaration and validation

A declaration has this shape: `{name, description?, schema, initialValue, updateRule?}`.

- `schema` can be a scalar, a nullable value, a nested object, an array, or a set of named records declared with `additionalProperties`.
- The initial value and every value committed later are checked against the same schema.

**Supported schema keywords** are defined by `packages/plugin-handlers-utils/src/dimension-schemas.ts`:

- `type`, `enum`, `const`
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- `minLength`, `maxLength`
- `minItems`, `maxItems`, `items`
- `properties`, `required`, `additionalProperties`
- `title` (can be translated), `description`
- `x-i18n`
- `x-enumLabels`: display names for scalar enum members. The value is still stored as the ID
- `x-derive`: [fields derived from the clock](#fields-derived-from-the-clock)

A keyword the server does not recognize causes a clear error. It is never silently ignored. Declarations, rules, values, batch updates, and queries all have limits on size, depth, and count. For the exact numbers, see [Value validation and localization](./world-data.md#value-checks-and-translation).

**Translation.** Only text nodes explicitly marked `x-i18n: true` can be written separately for each language in the world package. In ordinary JSON, keys, enum values, and business IDs that look like language codes are not treated as translations.

**A session stores only one language.**

- When a session is created, or when world data is synced, the `x-i18n` nodes in `initialValue` and `updateRule` become plain strings in the session's content language before they are written. If that language is missing, the fallback follows the [unified resolution rule](./i18n.md#one-resolution-rule).
- When a plugin declares a dimension during play with `dimension.initialize` (for example, by submitting the world package's declaration again at the start), the framework does the same thing. So whichever path is used, the session record has only one language, and repeated declarations do not conflict with records that were already imported.
- Dimension values, the saved `initialValue`, and `updateRule` in a session are all plain strings. Submitting a multi-language table is rejected by validation. Changes made by the model or the player also write only one text.
- `name`, `description`, the schema's `title`, and `x-enumLabels` are labels on the panel. They keep all their languages and are shown in the player's current interface language.

> [!NOTE]
> A development session that stores a dimension value in the multi-language form must be created again.

**Two ways to write it use the same declaration format**: in `world.yaml`, or in a whole-table dimension file, `data/dimensions.yaml` (`covel://world/dimensions → world:metadata.dimensions`).

- The dimension file replaces the whole table in `world.yaml`.
- The content of each item is one complete declaration, not a value.

## Fields derived from the clock

Some values depend only on world time: a countdown, a deadline, or a stage that advances with time. Write `x-derive` in the field's schema, and the value is calculated by code, not by the model:

```yaml
crownfire:
  name: Crownfire Countdown
  schema:
    type: object
    properties:
      minutesRemaining:
        type: integer
        minimum: 0
        maximum: 180
        x-derive:
          source: clock.elapsedSinceStart
          start: 180
          perUnit: -1
          min: 0
          max: 180
      stage:
        type: string
        enum: [distant, approaching, imminent, overhead]
        x-derive:
          source: clock.elapsedSinceStart
          start: 180
          perUnit: -1
          min: 0
          ranges:
            - { from: 121, value: distant }
            - { from: 31, value: approaching }
            - { from: 1, value: imminent }
            - { value: overhead }
      frontPassed:
        type: boolean
    required: [minutesRemaining, stage, frontPassed]
    additionalProperties: false
  initialValue: { minutesRemaining: 180, stage: distant, frontPassed: false }
  updateRule: Set frontPassed to true only when the narrative says the storm front has moved on.
```

In this example, `minutesRemaining` starts at 180. It goes down by 1 for every minute of world time, and it stops at 0. `stage` uses the same number to pick one of four labels. `frontPassed` has no `x-derive`, so the model maintains it using `updateRule`.

| Field     | Required | Description                                                                                                                                                                                                                                                                       |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | yes      | Currently only `clock.elapsedSinceStart`: the number of base units the world clock has counted since the start (minutes for a `calendar` clock, phases for a `phases` clock). See [World time](./world-time.md#runtime-and-state)                                                 |
| `start`   | no       | The number when `source` is 0. The default is 0                                                                                                                                                                                                                                   |
| `perUnit` | no       | How much the number increases each time `source` goes up by 1. Write a negative number for a countdown. The default is 1                                                                                                                                                          |
| `min`     | no       | The lower limit of the number                                                                                                                                                                                                                                                     |
| `max`     | no       | The upper limit of the number                                                                                                                                                                                                                                                     |
| `ranges`  | no       | Turns the number into a label. The first range from the top that contains the number gives its `value`. `from` and `to` are both inclusive endpoints, and either can be left out. The last item has no endpoints, and it catches the numbers that the earlier ranges do not cover |

**How it is calculated:**

1. Number = `start + perUnit × source`.
2. Limit it to the range between `min` and `max`.
3. With no `ranges`, the value is the number (an `integer` field is rounded). With `ranges`, the value is the label that the range gives.

There is no expression language. A world file contains no code.

**Validation** (`pnpm validate:world`, import, and submit all use the same rules):

- `x-derive` can be written only on the dimension value itself, or on a property that can be reached only through `properties`. Array elements and records under `additionalProperties` have no fixed position, so they cannot be derived.
- A field must have a single scalar type:
  - `number` / `integer` can omit `ranges`;
  - `string` and `boolean` must have `ranges`, and each `value` must be a value the field allows (its type, `enum`, or `const`);
  - `x-i18n` text cannot be derived.
- If the field has `minimum` / `maximum`, then `min` / `max` must fall inside them. This way the calculated number is never rejected by the field's own constraints.
- In `initialValue`, this field must equal the value when `source` is 0. The reason: at the start, no turn has run yet to calculate it.
- A dimension whose whole value is derived cannot also have an `updateRule`.

**Where the calculation happens.** It is done by `world-init/dimension-clock`. This is a runtime that does not call the model. It runs after each turn’s narrative without making another model call.

- It reads the clock after this turn's settlement (contract `world-time-evolution@1`), and it calculates the new value for each dimension that has `x-derive`. When a value changes, it commits a versioned `dimension.update`. This is not narrative settlement, so it does not use a settlement receipt.
- It runs after the time settlement and after the tracker (the model that updates dimensions according to rules). The value it reads already includes this turn's updates from the tracker, and it changes only the derived fields. So the two never write the same dimension from the same version.
- After the turn is saved, the panel and the next turn's narrative see the value that matches the clock.
- The value depends only on the clock reading, not on the previous value. If you rerun a turn, fork from an earlier turn, or a turn's time was not settled, the values calculated afterward still match the clock.
- If no plugin in this game provides this contract, the derived fields keep their initial values.

**The model does not write derived fields.**

- The schema and values that the tracker sees do not include these fields. Whether or not `update-dimensions` receives them, it keeps the current value when it writes.
- One dimension can have both derived fields and fields maintained by `updateRule` (like `frontPassed` in the example above).
- A dimension with only derived fields and no `updateRule` makes no model call. It still counts as a dimension that "changes with the turn", and it appears in the per-turn update section of the narrative prompt.
- If the player changes a derived field with `edit-dimensions`, the change is not rejected. The next time the clock moves, the recalculated value overwrites it.

## Session authority and sync

**Who is responsible, and where it is stored.** The kernel finds the one enabled provider for the contract `world.dimensions@1`, and it fixes that provider for this game. Each dimension is one record `{definition,value,version,lastTrackedSource?}` in the protected area `plugin_data[_dimensions]`. There is no new database table, and there is no permanent copy in the lorebook. General plugin data writes cannot change it.

**Two kinds of writes:**

- `dimension.initialize` creates only records that do not exist yet. Initializing again with the same declaration does not reset progress.
- `dimension.update` works on a whole batch, and every entry must include `expectedVersion`. If there is an unknown ID, an invalid value, or any entry whose version does not match, the whole batch is not written.
- The three database backends (memory, SQLite, and PostgreSQL) behave the same. On PostgreSQL, the session's row is locked inside the transaction. The values and the successful receipt are saved in the same transaction.

**Sync with the world package:**

- No matter which way a dimension is declared, the declaration is recorded in the import ledger.
- If the author's declaration has not changed, this game's progress is kept.
- Changing or deleting a dimension that has already evolved, was edited by hand, or still has turns waiting for settlement is reported as a conflict. Using `force` does not reset it.
- `sync-dimensions` syncs only dimensions. It cannot change the lorebook, characters, or other plugin data. It syncs declarations written in `world.yaml` and in the dimension file alike.

For the full sync rules, see [Preflight and Sync](./world-data.md#preflight-and-sync).

## Frozen reads and maintenance

**Public reads use a frozen base.** At the start of a turn, a runtime publishes the values from the end of the previous turn (Sₙ), without a model call. The `world.dimensions@1` input, public built-in queries, and the story prompt summary use this base. They neither read uncommitted updates nor fall back to author-defined initial values.

For functions and guards, `ctx.world.dimensions` overlays valid proposals from completed upstream runtimes and the current runtime onto that base. This lets `dimension-clock`, for example, calculate clock fields on top of the tracker’s proposed values. The view is a projection within the execution, not persisted state. After commit, the API and UI read the new authoritative values (Sₙ₊₁). See [World Model](./world-model.md).

**Two read-only built-in tools** that every plugin can use:

- `world-dimension-list`: lists the ID, name, type, and version.
- `world-dimension-get`: the argument is `{queries:[{dimension,path?,offset?,limit?,expectedVersion?}]}`. `path` supports dot and bracket notation, and also JSON Pointer. Results can be paged, and paging counts Unicode characters.

The full values are not all put into the prompt. For anything left out, use a paged query. Public reads (snapshots, the story prompt section, and public queries) do not include `updateRule` or `initialValue`.

**What the maintenance model (tracker) reads.** The tracker in `world-init` runs after the narrative.

- It needs this turn's narrative. Extraction of WorldIR is an optional side check.
- If there are no non-empty rules at all, there is no maintenance model call, and WorldIR extraction is not forced to run for it.
- If WorldIR extraction exists but failed, that must not be read as "no change".
- The rules and schema are in the `<dimension-rules>` section of its system prompt, and they do not change during the game. The frozen values are in `<dimension-values>` in the turn context (see [Prompt structure](./prompt-structure.md#layout-for-bookkeeping-runtimes)).
- The budget for `<dimension-rules>` is 24000 characters. Within the budget, the full rules and schema of every dimension that has rules are given directly, so one model call can usually settle everything. For dimensions that do not fit, `dimension-rule-get` is used instead (available only inside the responsible plugin, it reads the full rules and schema page by page from the frozen version), along with `world-dimension-get`.
- Reasoning is turned off for the tracker (`agent.reasoning: false`).
- The `expectedVersion` for each update in `update-dimensions` is taken by the tool from the version read during this run. The model does not fill it in.

**Text length has a safety margin.** In the schema shown to the tracker, the `maxLength` of a text field is 80% of the value the author wrote. The reason: the model does not count characters, so when it writes to the limit it often goes over by a few to several dozen characters. Then the whole submission is rejected, and the model has to be called again. With the margin, a slightly longer text still stays within the author's limit. Validation on write always checks the limit the author wrote.

**The tracker can read the world clock.** It has an optional input `world-time-evolution@1`. Its content is the clock **after** this turn's settlement (`runtime-inputs.worldTime.value`):

| Field               | Meaning                                  |
| ------------------- | ---------------------------------------- |
| `display`           | The time text shown to the player        |
| `unit`              | The base unit                            |
| `elapsedSinceStart` | The number of base units since the start |
| `elapsedThisTurn`   | The number of base units in this turn    |

For details, see [World time](./world-time.md#runtime-and-state). This input places the tracker after the time settlement, so it reads this turn's clock, not the previous turn's. If no plugin provides this contract, or if this turn's time could not be settled, the tracker still runs. It just has no clock to read.

**How to write rules that depend on time:**

- A value that can be written as a linear function of the clock, or as stage labels (countdown, deadline, stage), uses [`x-derive`](#fields-derived-from-the-clock), so code calculates it.
- A rule that depends on time but cannot be expressed that way (for example, a per-hour cost that depends on the current state) is written as a function of the clock, settled with `elapsedThisTurn`.
- Do not write it as "subtract the time spent in the story text". In a turn where the text does not mention time, this approach never updates.

**Stopping a countdown from freezing.** When nothing happens in a turn, the model tends to submit an empty result, and the countdown stays where it is. So `update-dimensions` asks the model to list, in `followsClock`, the dimensions whose rules depend on time. If the clock moved in this turn and a listed dimension is missing from `updates`, the submission is rejected and sent back with the clock, and the model submits again (see [update-dimensions](./tools.md#update-dimensions)). `followsClock` covers only rules that the model settles. `x-derive` fields are calculated by code, so they do not need to be listed, and should not be listed.

## Receipts, recovery, and player edits

**Receipts.** When the narrative is saved, the host records a "dimensions for this turn are waiting to be settled". It records the original `resultId`, `sourceTurnId`, the version of each dimension that was read at the time (`readVersions`), and the declarations that have a non-empty `updateRule`. Static settings with no rules are not copied into every receipt. A receipt does not store the text again. The original text is read from the result saved for that turn.

There are five states: `pending-settlement`, `settled`, `no-change`, `manual`, and `skipped`. For their meanings, see [Turn timing and settlement receipts](./world-model.md#turn-timing-and-settlement-receipts).

- A failure, a run that did not happen, and a scheduled skip are all not `no-change`.
- If automatic settlement fails, the narrative and its pending obligation remain. Other proposals follow the [commit-unit rules](./transactions.md): a failed optional unit and its hard dependents are discarded; a database error still rolls back the entire commit.
- For resolved receipts, only the most recent 20 are kept for each game. (When a new receipt is recorded, older ones are cleaned up.) Receipts that are still pending are never cleaned up.

**The tracker tries more than once.** A pending settlement blocks the turns that come after it, so here it is better to try again.

- If a model call times out or hits a transient error, it is retried automatically: `maxRetries: 3`. The whole runtime can take up to 120 seconds.
- A call that accepts the request but produces no text is waited for in turn: up to 60, 30, 15, and 15 seconds. A failure that returns quickly is retried up to three more times. (See `agent.loop` in the [plugin contract](./plugins.md).)
- Only if it still fails is a settlement left pending.
- A failure of another extraction runtime in the same turn does not stop settlement. The tracker settles from the narrative text alone, and the updates it commits take effect as usual.

**One automatic recovery before the next action.** A pending settlement does not leave the player stuck.

1. Before the player's next action starts (`POST /api/actions`, except `retry_runtime` / `retry_failed_runtimes`), the host first performs for the player the same recovery as "retry the original turn" in the pending-settlement prompt. It starts from the result already saved for the original turn, and it manually runs the tracker that `dimensionRecovery.trackerRuntimeId` points to.
2. When there are several pending settlements, they are handled one by one, from the earliest source turn to the latest. The results are written to the server log (`[dimension-settlement]`).
3. If this retry succeeds, the turn goes ahead as usual.
4. Only if it still fails is the turn blocked. The error message tells the player to retry or skip in the pending-settlement prompt, and then send again.

If the dimension is provided by a community plugin, there is no automatic retry, because a manual run requires the player's approval, and it can only be done from the panel.

**The player's actions** use the recovery information that the host verified in the snapshot (recovery metadata). They call the existing runtime RPC:

- Ordinary edits, "handled manually", and "explicitly skip this settlement" call `editorRuntimeId`, using the same `dimension.update` and `expectedVersion`.
- "Retry the original turn" calls `trackerRuntimeId` directly, with `retryFromTurnId` included. Only an explicit retry that includes both `sourceTurnId` and `retrySeedResults` can read the inputs frozen for that turn. An ordinary manual call has no turn inputs. A recovery call does not allow `recursiveCall`.
- A receipt that already has a final state cannot be recalculated. A manual edit does not also clear the pending settlement.
- A version conflict uses the fixed error code `dimension-version-conflict`, and it returns the current version. A failed save carries this in the `code` field of the proposal. The host does not decide by parsing the error text. After refreshing, the client retries only when the player explicitly asks. It does not merge automatically.

**Notifications.**

- `dimensions.changed` publishes only saved public values.
- `dimensions.settlement.changed` publishes receipt state separately.
- Notifications are sent only after the transaction is saved, and the version only moves forward, never back. After a subscription disconnects and reconnects, the authoritative snapshot is read again.
- `SessionSnapshot.dimensions` is a required field. The responsible plugin and the recovery information are verified by the host. A plugin cannot claim these permissions by writing its own data.

**Interface.**

- The general session panel shows scalars, fields, and records according to the schema. It can edit ordinary fields and add or remove rows that the schema allows. For complex nested values, it provides a JSON entry point, and the validation is the same.
- The version that an edit is based on is fixed when the editor opens.
- The world editor changes the declaration. Changing a world's declaration does not mean changing the current value in one particular game.

**Browser local storage.** Private browser storage (BrowserVault) keeps records, versions, receipts, and the import ledger using the existing workspace and atomic save points. Only a brand-new opening save point that has no dimension records and no ledger is initialized from the declarations. Recovery and forking do not reset existing state.

## Boundaries and development data

- Adding, removing, and equipping items is still handled only by the inventory plugin. Affinity, characters, and world time each belong to their own plugins. They do not move into dimensions, and they are not stored in both places.
- A dimension schema can express "rows of items", but that does not mean it can replace inventory operations. A future migration must switch the single responsible party over.
- Dimensions do not handle triggering hidden events, and they do not guarantee that event content stays secret.

> [!IMPORTANT]
> Early dimensions that stored only "a single value", dimension copies in the lorebook, and the sessions and browser save points from that time must all be created again. There is no migration and no reading of the old format.

Related pages: [World declarations and import](./world-data.md), [World Model](./world-model.md), [Plugins](./plugins.md), [Extension points](./extension-points.md), [Tools](./tools.md), [API](./api.md), [Protocol](./protocol.md), [Transactions](./transactions.md), [Prompt structure](./prompt-structure.md).
