# World Model

The World Model is the part of a game's world data that the kernel keeps: the world record, characters and their attribute definitions, the lorebook, and the current values of dimensions. This page explains the rules for each of them: how a name finds a character, when a dimension value can be read and when it can be updated, and who owns a lorebook entry.

World authors mainly need the "Aliases" section. The rest is for people who write plugins. For how to write the files in a world package, see [world data](./world-data.md).

A plugin reads the World Model through four entry points:

| Entry point                 | Contents                                      |
| --------------------------- | --------------------------------------------- |
| `ctx.world.worldRecord`     | The world record                              |
| `ctx.world.characterSchema` | The character types and attribute definitions |
| `ctx.world.characters`      | Characters                                    |
| `ctx.world.dimensions`      | The current values of dimensions              |

`ctx.world.seats` sits beside them: the session's seats (who plays and which characters they control), read-only. It is session state, not part of the World Model; see [Seats](#seats).

These entry points are read-only. To write, use a proposal (a request that says "I want to change this", which the kernel validates and then saves in one batch).

- For characters, the character schema, and dimensions, `ctx.world` can read valid proposals from completed upstream runtimes and overlays the current runtime’s own valid proposals on each read. These changes still need to pass commit before they persist.
- Public dimension inputs, built-in queries, and story summaries use the base frozen at the start of the execution. They differ from the projected `ctx.world` view used for calculations; see [Frozen reads and maintenance](./dynamic-dimensions.md#frozen-reads-and-maintenance).

For which fields exist and who manages each part, see [plugin contracts](./plugins.md#world-model-and-data-boundaries).

## Characters and the character schema

A world package can declare a `characterSchema` in `world.yaml`. When a session is created, it is copied into the session.

- It contains `types` (character types) and `attributes` (attributes).
- `player` is a reserved type meaning "a character the player can play". A game can have several. Other types are declared by the schema. Which one the player plays right now is decided by the [seats](#seats).
- A character's `fields` are validated against the current schema.
- The proposal that changes the schema is `character.schema.set`. Its content is `{types, attributes}`, and the kernel increments the version.

For world files, initial character values and examples of import, see [world data](./world-data.md#world-character-schema) and [the character file](./world-data.md#one-character-file-per-world).

Some boundaries:

- Characters are created and updated only through character proposals and character tools.
- The character panel reads the session's `session.characters`. The display of attributes reads the session's `characterSchema`.
- A world's character record can carry a plugin's data (such as roleplay notes), in the field the plugin declares. On import the kernel gives it to the receiving plugin, keyed by the character's `id`. It does not become the character's `fields` and does not stay in the character record.
- The kernel's character records are not copied into any plugin's data.
- A dimension's structure does not turn into character attributes automatically. Characters, the inventory, affinity and time are each maintained by their own plugin.

Validation when an AI generates a world:

- When a world is created, before the added characters are accepted, the **whole group** of characters is validated against the generated `characterSchema`: character types and attribute constraints.
- When a world is edited, all characters are validated against the merged schema. It is not enough to check only the new ones.

### Aliases and name resolution

In a story, one person can have many names: a name, a nickname, a title, or a name written in another script. So besides `name`, a character can have an optional `aliases` field. It is an ordered list of strings, stored in the form used for display. When there are no aliases, the field is absent.

```ts
interface CharacterRecord {
  id: string;
  name: string;
  aliases?: readonly string[]; // e.g. 守灯人伊索德 (the lamp keeper Isolde) → ["伊索德", "守灯人"]
  type: string;
  // description, fields, version, createdAt, updatedAt
}
```

**One name refers to one person.**

- Within a game, no alias can be the name or alias of another character. A character's name also cannot be another character's alias.
- Importing a world, reading during execution and the final save all use the same validation (`validateWorldModel`). A violation is an error, and the error says which other character is involved. It never quietly picks one.
- Two characters with the same name (but different types) are still allowed. When you look up that name, the result is "ambiguous".

**There is only one rule for turning a name into a character**: `resolveCharacter(characters, query, options?)` from `@covel/plugin-handlers-utils` (`@covel/shared` exports a function of the same name too). The built-in character tools and built-in plugins all use it. There are three possible results:

| Result      | Meaning                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `found`     | A unique character matched, in this order: by ID as written, then by name, then by alias. `matchedBy` says which step matched.               |
| `ambiguous` | The name or alias belongs to more than one character. `candidates` lists them. The caller must report this, and cannot choose on its own.    |
| `missing`   | No character has this name. `closest` lists up to 5 similar characters by similarity, to help an error message. It is not used for matching. |

Before comparing names and aliases, `characterNameKey` normalizes the spelling:

- **Differences that count as the same**:
  - letter case;
  - full-width and half-width characters (NFKC);
  - leading and trailing spaces, and runs of spaces;
  - quotation marks and book-title marks around a name (`"…"`, `「…」`, `《…》`);
  - the middle dot in translated names (`・`, `·` and `•` are treated as the same);
  - different forms of the apostrophe;
  - a leading `the` in English.
- **Differences that do not count as the same**: titles, honorifics and forms of address (`Dr.`, `Sister`, `先生`, `小姐`, `老`). `Dr. Park` and `Mr. Park`, or "陈先生" and "陈小姐", can be two different people. Removing the title would merge them into one. Write a title that refers to only one person as an alias.
- **No fuzzy matching**: edit distance is not compared, and pronunciation is not compared either. A misspelled letter does not match. It only appears in `closest`, so the model can correct it.

`{ partial: true }` is for reading only. When there is no exact match, if exactly one character's name or alias contains the query (or is contained in it), that character is returned. For example, `Mina Park` finds `Dr. Mina Park`.

> [!WARNING]
> Writes must not use `partial`. Today "陈" matches only 陈远山. When a second person surnamed 陈 appears in the story, a write would land on the wrong person.

**Where aliases come from:**

- The world author writes `aliases` in `characters/characters.json` (see [the character file](./world-data.md#one-character-file-per-world)). A language file can replace the whole list.
- When the story reveals a new name, the model adds it through the `aliases` parameter of `update-character` / `sync-characters.updates[]`. `create-character` also accepts `aliases`.
- The `aliases` of the `character.upsert` proposal:
  - With `expectedVersion`, the aliases are appended after the existing ones. Two appends in the same turn are both kept, in the same way that `fields` are merged.
  - Without it, the value is the complete list.
  - An alias that is the same as the character's name, and a duplicate alias, are removed when written.
  - A proposal with `expectedVersion` can also carry `removeAliases`. These aliases are removed from the existing ones first (compared in the normalized form, and any that are not there are skipped), and then `aliases` are appended. This is how a wrongly attached alias from the model is undone. Otherwise, under "one name refers to one person", the character who really has that name could never get it. The error for a conflicting alias also points to this.

**What the model sees**: a name followed by a bracket: `- 守灯人伊索德 (aka 伊索德, 守灯人) [npc] | …` (`characterLabel`). `characterSheetSegments`, `{{ characters.npcs }}`, `list-characters`, and the roster of character tracking add this part only when there are aliases. A character without aliases adds nothing, not even one character of text. In the four built-in worlds, each character gains 5 to 9 tokens this way.

**What the player sees**: aliases are shown in the character panel, read-only. The play interface does not offer editing.

**A player's name cannot be the name or alias of a character already in the world** (compared using `characterNameKey`). The reason: worlds often write common names as aliases (`Tomas`, `June`). If a player picks such a name, the save is rejected. A name that is the same as an NPC's full name is not rejected, but every later lookup of that name returns `ambiguous`. So the three steps of character creation all apply the same rule:

- **The character-creation form** has a validator, `player-name` (registered by `char-creator` with `registerFormValidator`). Submitting a name that is already taken gets `form_rejected`. `issues` points to the `characterName` field, and the text uses the session's content language. The answer is not saved, and the player renames and submits the same form again.
  - The form is sent to the client and stays in the session messages. So it does not carry any character's name or alias. It carries a SHA-256 digest of those names, salted with the form (stored in `validation.data`).
  - The digest only stops the list of names from being read directly. It does not stop someone who already has a guessed name from checking it.
- **The guard of `player-init`** checks again, because the characters in the world may have changed after the form was sent. If the name still conflicts, it does not produce `character.upsert`. Instead, it makes the runtime send the form again, and the `notice` explains that a character already uses this name. The other answers are kept. This keeps the opening from failing over and over.
- **`create-character`**, when it creates `type: "player"`, reports an error if the name is another character's name or alias. It says the player must give another name. It does not return that NPC as an "already existing character".

The save rule has not changed: two non-player characters can share a name (lookup then returns `ambiguous`), but a name that equals someone else's alias is rejected.

> [!IMPORTANT]
> The `characters` table has an `aliases` column. Startup schema checks reject old SQLite or PostgreSQL development databases that lack it; the app does not add the column automatically. Follow the [development-data instructions](./env-registry.md#plugin-extension-development-data) to back up and create a new database. The `aliases` field itself is optional, so current-format browser-private saves may contain characters without aliases.

## Seats

A seat describes who plays, in which role, and which characters they control. The seats are stored in the `seats` field of the session record. The kernel owns them, and they are saved with snapshots, forks and browser saves.

| Field                | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `id`                 | The seat's ID within the session. The switch endpoint names the seat by it      |
| `controller`         | Who sits there: `human` (the person at this machine) or `empty`. AI comes later |
| `role`               | `player`, `host` or `spectator`                                                 |
| `characters`         | The bound characters: `"auto"`, or a list of character IDs                      |
| `currentCharacterId` | Optional. The character the seat currently plays                                |

**The default seat**: every new session has one seat, `{ id: "main", controller: "human", role: "player", characters: "auto" }`. Single-player play is the same as before.

**Binding** is derived when it is read, never written:

- `"auto"` binds every character of type `player`, in the order of the character list, leaving out the characters another seat lists explicitly.
- An explicit list binds the characters on it that still exist, in list order.
- Creating a player character (a character-creation plugin, a world import, `create-character`) needs no seat write: the next read binds it to the `"auto"` seat.

Every write checks these rules: seat IDs are unique; at most one seat uses `"auto"`; a character ID appears in one seat's list only, and only once in it.

**The current character** of a seat is its `currentCharacterId` while that character is bound to the seat and exists, otherwise the first bound character, otherwise none. When the current character is deleted, the seat falls back to the first bound one.

**The primary seat** is the first seat with `controller: "human"` and `role: "player"`. The story follows its current character:

- `<player-character>` and `{{ player.character }}` in the prompt are that character (see [prompt structure](./prompt-structure.md#writing-that-keeps-the-system-prompt-unchanged)).
- `{{ characters.npcs }}` and `<character-profiles>` leave out only that character. The other characters the player controls are listed with their `[player]` tag.
- The `PostContextAssembly` payload names it in `currentCharacterId` (see [hooks](./hooks.md)).
- The player status in the game view shows it.

A plugin reads the same rule through three SDK helpers:

```js
import { currentCharacterOf, primarySeat } from "@covel/plugin-handlers-utils";

const player = currentCharacterOf(
  primarySeat(ctx.world.seats),
  ctx.world.characters,
  ctx.world.seats,
);
```

`seatCharacterIds(seat, characters, seats)` returns the IDs of the characters bound to one seat.

**Switching the current character**: `PATCH /api/sessions/:id/seats/:seatId` with the body `{ "currentCharacterId": "…" }`. The character must be bound to that seat, and a human must control the seat. It applies from the next turn. See [API](./api.md#session-seats). The game view has no switch control yet.

**The role decides which actions a seat may submit.** What a player submits each time is a list of actions (see [API · submit_actions](./api.md#submit_actions)). The server checks them against the seat's role:

| Role `role` | Base action kinds it may submit           |
| ----------- | ----------------------------------------- |
| `player`    | `say`, `act`, `command`                   |
| `host`      | `narrate`, `direct`, `advance`, `command` |
| `spectator` | `advance`                                 |

- This table is `ROLE_ACTION_KINDS` in `@covel/shared`; the server reads only it.
- A plugin's action kind declares which roles may use it (`contributes.actionKinds[].roles`, default `[player]`).
- An action taken as a character (`say`, `act`, and plugin kinds by default) may use only a character bound to the seat; left out, it is the seat's current character. A seat no human controls cannot submit actions.

The bundled plugins that still use `find(type === "player")` (inventory, checks, memory, character creation and others) act on the first player character when there are several, until they move to seats.

## Dynamic dimension snapshot

The `dimensions` in a world package is the author's declaration: its structure, initial value and an optional update rule. `ctx.world.dimensions` is the **current value in this game**. Its shape is set by the common contract `world.dimensions@1`:

```ts
interface DimensionSnapshotEntry {
  name: I18nText;
  description?: I18nText;
  schema: DimensionValueSchema;
  value: JsonValue;
  version: number;
}

type DimensionSnapshot = Readonly<Record<string, DimensionSnapshotEntry>>;
```

Where it is read:

| Who reads it        | How                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin              | `ctx.world.dimensions.reputation.value`                                                                                                                    |
| Prompt template     | `{{ world.dimensions.reputation.value }}`                                                                                                                  |
| Client session view | `snapshot.dimensions.reputation.value`                                                                                                                     |
| Model               | The built-in tool `world-dimension-get` (`path` is relative to that item's `value`) and `world-dimension-list` (lists only the ID, name, type and version) |

Rules:

- Each item that is read does not include `initialValue` or `updateRule`. It also does not include which turn it was last updated in.
- The value is raw JSON. When it is shown or queried, only nodes that the schema explicitly marks with `x-i18n` are translated.
- When no plugin is responsible for dimensions, or the dimensions have not been initialized yet, the snapshot can be empty. When no plugin responsible for dimensions is turned on as a session is created, the dimensions the world declares are not imported and the session starts as usual; see the [session API](./api.md#post-apisessions). The kernel does not store dimensions itself.
- When the plugin responsible for dimensions is not running (it is not installed, failed to load, or misses a dependency), the game goes on and the dimensions pause:
  - The story reads the saved values. No plugin can write the dimensions, and no settlement obligation is recorded.
  - The session view returns the saved values as usual, and the game screen tells the player the dimensions are paused.
  - Once that plugin is back, the dimensions change again. Another plugin responsible for dimensions cannot take over: while it is on, turns are refused.
  - It cannot fall back to the world package's initial values, and it cannot pretend the snapshot is empty.
- When the plugin responsible for dimensions runs but the read fails, this must be an error.

### Ownership and writing

**Who is responsible.** The built-in `world-init` provides the world context (extension point `session.world-context@1`, which can have only one provider) and `world.dimensions@1`. The framework finds the one responsible plugin by its contract. It does not decide by plugin ID. The ID of the responsible plugin (`dimensionProviderPluginId`) is filled in by the host. The editor and tracker runtime IDs in `dimensionRecovery` must really belong to that plugin.

**Only one.** One plugin is responsible for the dimensions of a game, and the framework does not pick one for the player.

- When the selection at the start has several plugins that provide `world.dimensions@1`, the preflight and session creation return `409 dimension_provider_conflict`, with these plugins in `details.candidates`. The prep screen asks the player to keep one of them and turns the others off.
- Turning on another plugin responsible for dimensions during a game also returns 409; see [turning plugins on and off](./api.md#put-apisessionsidpluginspluginid).
- Turning on the first plugin responsible for dimensions during a game imports the world's dimensions at once; see [receivers that join after the game starts](./world-data.md#receivers-that-join-after-the-game-starts).

**Where it is stored.** Each dimension is a record `{definition, value, version, lastTrackedSource?}` in the protected area `_dimensions` of the responsible plugin.

- The declaration and the current value share one version number, which starts at 1.
- Each game of the same world is isolated from the others. Nothing is written back to the world package.
- Nothing is stored anywhere else, and there is no resident lorebook entry.

**How it is written.** Only two proposals can write it:

| Proposal               | Content                                                                                   | Behavior                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dimension.initialize` | `{definitions}`                                                                           | Creates only records that do not exist yet. Initializing again with the same declaration does nothing, and does not reset progress. A different declaration already adopted is a conflict. |
| `dimension.update`     | `{updates: [{id, expectedVersion, value, reason?}], source?, readVersions?, settlement?}` | The batch is saved only when every value satisfies the schema and every version matches. It is never merged automatically, and it is not "the last write wins".                            |

- The `source` / `readVersions` used in automatic settlement are provided by the host, not filled in by the model.
- Ordinary plugin data writes, batch writes, deletes and REST writes cannot touch this protected area.
- A player changing a value submits the same kind of proposal through a runtime RPC. An ordinary manual change carries no settlement source, so it does not automatically clear a turn that is pending settlement.
- For the details of batch saving and version comparison, see [transaction contracts](./transactions.md#versioned-plugin-data-batch-cas).

### Turn timing and settlement receipts

```text
Obligation for the previous turn is cleared
  → dimension-context publishes the committed snapshot Sₙ in pre-turn (does not call a model)
  → narrator, WorldIR and tracker use the same version content as their shared read baseline
  → post-turn tracker evaluates the rules and checks the version again when it commits
  → the current value and the success receipt are written atomically; after the turn, the client reads the new committed version
```

**Within one turn, the value read does not change.** If the player edits it by hand at the same time, or the tracker proposes a change, the value this turn reads does not change. The next execution reads the saved value again.

- When `dimension-context` ran in this execution but did not succeed, the narrative is skipped (`dimension-snapshot-unavailable`), and the whole execution is not saved. The writes of runtimes before it, the conversation record and the turn count are all rolled back. The player can retry the same action.
- When `dimension-context` was not scheduled to run (a manual run that runs only the narrative, or a retry), the narrative uses the value that was already saved when the execution started.
- The narrative cannot depend on the output of a tracker that runs after the turn. An export with `recordAs` cannot stand in for a saved value either.
- The prompt holds a summary within a length budget. It is queried when needed, and large tables are not expanded by default.

**Settlement obligation.** When there is an automatic maintenance rule, the host records, at the same time as the narrative is saved, that "this turn's dimensions are not settled yet". It is bound to this turn's narrative result and turn number.

- A tracker that did not run, failed, or hit a version conflict does **not** mean there was no change.
- When there is no automatic rule, there is no model call for maintenance and no settlement obligation.

Receipts are stored in `_dimension-settlements`, with five states:

| State                | Meaning                                                                                                             | Allows the narrative to continue |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `pending-settlement` | Not yet settled successfully. This includes not run, maintenance failed, and conflict.                              | No                               |
| `settled`            | The value change and the success receipt were committed atomically                                                  | Yes                              |
| `no-change`          | A receipt that says, after explicitly evaluating and validating the read versions, that nothing changed             | Yes                              |
| `manual`             | The player explicitly confirmed that this source was handled by hand                                                | Yes                              |
| `skipped`            | The player explicitly skipped this source. The current value is kept, and it is not calculated automatically again. | Yes                              |

- A story that was already saved can be kept, with a receipt marked as pending settlement attached. A rejected settlement does not void a valid narrative. If a database error happens, the whole thing is still rolled back.
- Before the next narrative, the system checks for unresolved obligations. There are three ways to resolve one: retry the original turn, confirm it by hand, or explicitly skip it.
- "Change a value" and "confirm it has been handled by hand" are two different actions.

**What a receipt stores:**

- A pending receipt stores: a reference to the source, the version of each dimension read in this turn (`readVersions`), the dimension declarations that have update rules, and the state. It does not store the narrative text again. On a retry, it reads from the result saved for the original turn.
- Once a receipt reaches a final state, the declarations and `readVersions` are cleared. Only the result's identity, state and version remain, to prevent settling twice.
- A source that already has a final state is not settled again.
- Recovery, restarts, branches and the browser's save points all keep the obligations and receipts.
- The client receives only [the public summary and the recovery entry point](./api.md#dimension-editing-and-recovery-of-pending-settlements). It does not receive private rules or the read baseline.

**Details of initialization.** A dimension is initialized only through the `dimension.initialize` proposal. It also goes through the `PreStateCommit` check, and it is written to the database when the runtime that proposed it saves. If it is rejected, nothing is written. If it is rewritten, the rewritten declaration is written. A receipt records only records that were actually saved. So an initialization that was rejected in the same transaction, or dropped together with its runtime, does not appear in a receipt.

**What the player sees in the interface:**

- During play, dimension values are read-only.
- When a turn is pending settlement, a notice appears above the conversation, and the player can retry or explicitly skip it.
- Free editing of values and "confirm it has been handled by hand" are in the session data view used for debugging.
- Entry labels and error messages shown to the player use the interface language.

> [!IMPORTANT]
> Dimensions must be written in the [current declaration format](./world-data.md#dynamic-world-dimensions-dimensions). Earlier "single value only" dimensions, dimension copies stored in the lorebook, and snapshots from that time cannot be read, and there is no automatic conversion. Update the world package, and create again the affected development worlds, sessions and snapshots. Dimensions provide only data that changes with the plot. They are not responsible for hidden events or trigger-by-condition. That is the job of [hidden data](./world-data.md#hidden-data-visibility-hidden) and the `story-events` plugin.

## Lorebook

The lorebook is the set of setting entries in one game.

**Who owns an entry.** An entry is identified by three things: `(sessionId, owner, id)`. The `owner` can be world, player or plugin:

- An entry imported from a world package belongs to the world.
- The player's editing interface handles only entries owned by the player.
- Entries that a plugin writes through `lorebook.upsert` are owned according to the source of the proposal. A plugin cannot overwrite an entry with the same ID that belongs to another owner.

For the management interface, see the [lorebook API](./api.md#lorebook). For import targets, see the [world data targets](./world-data.md#target-uri).

**Disabling an entry.** `enabled: false` means fully disabled:

- It no longer enters the prompt automatically. It does not take part in keyword search or vector search.
- The vector index is updated slowly in the background. Even when old vectors have not been cleared yet, a search checks the entry's current state, so the old vectors of a disabled entry are not returned. Later index updates clear its vectors and progress.
- When it is enabled again, keyword search returns right away. Vectors not yet cleared can be used at once. Vectors that have already been cleared are rebuilt by a later index update.
- Disabling does not delete the entry. It also does not affect entries with the same ID owned by others, or the memory blocks of characters or plugins.

> [!NOTE]
> Old lorebook tables that have only a `plugin_id` column and no owner are not upgraded automatically. For how to handle this in a development environment, see the [migration notes](./env-registry.md#plugin-extension-development-data).
