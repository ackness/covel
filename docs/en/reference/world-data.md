# World Data

This page explains which files a world package can hold, how to write each one, and when Covel reads them. Read the first half when you write a world and need the file formats or validation errors. Read the second half if you are a plugin author who supplies data to worlds.

If you are making your first world, go through [the first world](../worlds/first-world.md) first. To preset quests, items and affinity, see [starting content](../recipes/starting-content.md). To set up point buy for the opening, see [point buy and dice checks](../recipes/point-buy.md).

Some terms used throughout this page:

- **World package**: a folder that holds `world.yaml`, `WORLD.md`, and optional data, characters and images.
- **Source**: one data source in a world package. Usually a file. For media, it is a directory.
- **Descriptor**: an optional manifest file (`data/world.data.yaml`) that lists each source one by one. Most worlds do not need it.
- **Session**: one game that a player starts with this world. The world package's data is copied into the session when the session is created. After that, each session changes on its own.

## World Package

**The smallest world package** has two files:

- `world.yaml`: the manifest of the world. Five fields are required: `schemaVersion`, `id`, `name`, `summary`, and `defaultLocale`.
- `WORLD.md`: the world lore text.

When you add a kind of content later, put a file in the agreed location. You do not need to register it anywhere:

| File                         | Content                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/dimensions.yaml`       | World dimensions                                                                                                                                           |
| `data/lorebook.yaml`         | Lore entries that are triggered by keywords                                                                                                                |
| `characters/characters.json` | Domain character records                                                                                                                                   |
| Path declared by a plugin    | Data that the plugin receives, for example `data/quests.yaml` (quests), `characters/main-cast.json` (character blueprints), `media/portraits/` (portraits) |

A plugin declares the last row's paths itself. Each installed plugin brings its own agreed paths. The command below lists all the paths in the current version, with an example of each kind of data:

```bash
pnpm describe:authoring
```

The rules for this convention are in [import by convention](#import-by-convention-no-descriptor).

Recommended structure:

```text
worlds/my-world/
├── world.yaml
├── WORLD.md                         # default world lore (fallback for all languages); you can add language versions such as WORLD.en-US.md
├── data/
│   ├── world.data.yaml               # optional: needed only when a file is not in the convention location, or when you set the order
│   ├── dimensions.yaml
│   ├── memory-blocks.json            # optional: genre memory definitions
│   └── rules/                       # optional: genre rules, imported into living-world-rules
├── characters/
│   ├── main-cast.json                # optional: character.blueprints@1 plugin content
│   └── characters.json               # general domain character records
└── media/
    ├── portraits.json               # optional: portrait generation manifest
    ├── portraits/                   # optional: character portraits
    ├── presence.json                # optional: content-addressed mapping of characters to portraits
    ├── scenes.json                  # optional: scene picture generation manifest
    ├── scenes/                      # optional: day / night scene pictures
    └── scenes.registry.json         # optional: scene registry for scene-stage
```

`media/portraits.json` and `media/scenes.json` are image generation manifests. Only four scripts read them: `scripts/generate-portraits.mjs`, `scripts/emit-presence.mjs`, `scripts/generate-scenes.mjs` and `scripts/emit-scenes.mjs`. The server does not import them, and you do not need them while you play. A world that does not plan to generate images again can leave them out. During play, the files that are read are `presence.json`, `scenes.registry.json` and the image directories.

`world.yaml`:

```yaml
schemaVersion: "1.0"
id: my-world
name: 我的世界
summary: 一个示例世界。
defaultLocale: zh-CN
pluginPolicy:
  presetId: traditional-story
  requested:
    - pregame
    - world-init
    - char-creator
  recommended:
    - character-blueprint
  preferredTags:
    - mode:traditional-story
  avoidedTags:
    - mode:dialogue
worldData: data/world.data.yaml # optional: when omitted, the file is read from the convention path; see "Import by convention" below
defaultViewMode: stage
```

- `worldData` is the path to the descriptor, relative to the world package root. Write it only when the world package has a descriptor.
- For all the fields of `world.yaml`, see the generated [World manifest field table](./schema/world-manifest.md). For dimensions in a separate file, see [World dimensions field table](./schema/world-dimensions.md).
- The manifest accepts only current fields. A field it does not know causes an error. It is never ignored quietly or replaced with another form.

### How the lore reaches the story

The model reads `WORLD.md` on every turn. It is placed in the `<world-lore>` section of the story prompt.

- **Language**: if the world declares more than one language, Covel reads the matching `WORLD.<locale>.md`. The session's language is fixed when the session is created, and the lore is chosen by it.
- **Edited lore comes first**: when a player has edited the world lore in the app, the edited version is used for the default language. If the session has its own lore (`loreOverride`), the session's copy is used, even when it is empty.
- **Length limit**: about 8,000 tokens. This is an estimate: about one token per Chinese character, and about one token per four other characters. When the text is too long, it is cut after the last full line that fits.
- [Narrator-only lore](#narrator-only-lore-narrator-only) also counts toward this limit, because the model reads it.
- `pnpm validate:world` gives a warning (`prompt-size`) when the text is too long. The warning shows the estimate and the limit. The world detail page also shows a note for a world whose lore does not fit.

The framework does not pull special prompt text out of fields such as `tone` or `startingConditions`. To have the model know the tone and the starting conditions, write them in the lore or in the dimensions.

The in-app translation and the AI edits both call a model, which takes some time. Before the result is saved, Covel checks again that the world is still the same one. If the world was edited or deleted during that time, or rebuilt with the same ID, the old result is dropped and does not overwrite the current world. When a translation succeeds, only the new language and its lore are added. Edits that were already saved are kept.

### Narrator-only lore (narrator-only)

`WORLD.md` has two kinds of readers. The model reads the whole file. Players can also see it: in the "World" tab of the right panel, in the "World Document" on the session-prep screen, and on the world detail page.

Put content that only the narrator should know (hidden threads, answers to mysteries, and how to run the scene and control the pacing) between two marker lines:

```markdown
## 人物

- **梅瑞尔**：酒馆老板娘，记性好、嘴巴紧。

<!-- narrator-only -->

## 暗线

灯是守灯人自己吹灭的。前三个房间里不要说破。

<!-- /narrator-only -->

## 开局

雨夜，你推开酒馆的门。
```

- The content between the markers goes into the prompt as usual. Rules and settings written here apply during play, just like anywhere else. The lore the model reads does not include the two marker lines.
- The lore that players see does not include the content between the markers.
- The two marker lines are HTML comments, so they do not show in a Markdown preview. Each marker takes up its own line. Case and spaces do not matter (`<!--Narrator-Only-->` also works). One lore text can have several sections.
- Language versions (`WORLD.<locale>.md`) use the same format, with the markers in the same places in each version.
- When you are not sure, treat the text as hidden from players:
  - Without an end marker, everything from the start marker to the end of the file is hidden.
  - A marker written wrong (for example `<!-- end narrator-only -->`) is treated as a start marker.
  - A marker line inside a code block still counts as a marker.
  - `pnpm validate:world` gives a `lore-narrator-only` warning for these cases and points to the line number.
- When a player edits the "World Document" on the session-prep screen, the player sees and edits only the visible part. The content between the markers is kept as it is in the lore that this game uses.
- The AI creation and editing of worlds in the app works on the whole lore text, markers included.

> [!WARNING]
> This is "no spoilers", not secrecy. The world record, the world package files and the `lore` returned by the API are all the whole lore text. Anyone who reads the files or calls the API can see it. For content that should be revealed only when a condition is met, use [hidden data](#hidden-data-visibility-hidden).

### Dynamic world dimensions (dimensions)

A dimension is a piece of world data that is recorded and may change over time, such as reputation, known places, the state of a city wall, or a countdown.

- The author chooses each dimension's ID. There is no fixed set of kinds. `geography`, `factions` and `powerSystem` are only common examples. Money, reputation and a codex can each use their own ID and data structure.
- The world package holds the **declaration**: the structure, the initial value and the update rule. The **current value** belongs to the session. Two games of the same world each change on their own. They never write back to the initial value in the world package.

This section explains how to declare a dimension. For how a dimension is read and updated during a game, see [dynamic world dimensions](./dynamic-dimensions.md).

#### Declaration format

```yaml
# world.yaml
dimensions:
  reputation:
    name: 声望 # the translation goes in world.en-US.yaml at the same path
    description: 主角在当地的公开声望。
    schema:
      type: integer
      minimum: 0
      maximum: 100
    initialValue: 0
    updateRule: 完成居民委托后增加 5；只计已完成的委托，不计承诺。
  discoveries:
    name: 已知地点
    schema:
      type: object
      additionalProperties:
        type: object
        properties:
          description: { type: string }
          visited: { type: boolean }
        required: [description, visited]
        additionalProperties: false
    initialValue: {}
    updateRule: 明确发现具名地点时增加条目，亲自抵达后将 visited 设为 true。
```

| Field          | Required | Description                                                                                                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`         | yes      | Display name. You can translate it.                                                                                                                          |
| `description`  | no       | What the dimension means. You can translate it.                                                                                                              |
| `schema`       | yes      | The shape of the value, written with the JSON Schema keywords in the table below                                                                             |
| `initialValue` | yes      | The starting value. It must match the schema. `null` is a value, and it does not mean delete.                                                                |
| `updateRule`   | no       | The update rule, in plain language. You can translate it. It is kept up to date automatically each turn only when it is not empty in the session's language. |

Rules:

- The ID must match `^[a-z][a-zA-Z0-9_-]{0,63}$`. It cannot be `__proto__`, `prototype` or `constructor`.
- Each declaration accepts only the fields in the table above. Extra fields are rejected.
- You do not need a separate "table / single value" format. The schema can express all of them:
  - A scalar is a single value.
  - A nested object is a group of related values.
  - An array of objects is a multi-row record.
  - `additionalProperties` is a group of named records that can be added to over time.
- The player can change values, and can add or remove rows that the schema allows. The player cannot create a dimension or change its structure during a game.

**Values that change with time** (countdowns, deadlines, phases) can be written in two ways:

- Add `x-derive` to the field's schema. The code works out the value from the world clock, and the model is not involved. See [fields derived from the clock](./dynamic-dimensions.md#fields-derived-from-the-clock).
- For a rule that depends on time but cannot be written that way, write the `updateRule` as a function of the clock. The model that maintains the dimension can read the settled world clock and the time elapsed since the start on every turn. See [frozen reads and maintenance](./dynamic-dimensions.md#frozen-reads-and-maintenance).

#### Value checks and translation

`schema` supports a clear, closed set of keywords. It is not the full JSON Schema:

| Category   | Supported keywords                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Type       | `type`: `string/number/integer/boolean/null/object/array`. A list of types can also be used for a union, such as a nullable value. |
| Common     | `title`, `description`, `enum`, `const`                                                                                            |
| Number     | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`                                                                       |
| Text       | `minLength`, `maxLength`                                                                                                           |
| Array      | A single `items` schema, `minItems`, `maxItems`                                                                                    |
| Object     | `properties`, `required`, `additionalProperties` (a boolean or a schema)                                                           |
| Localizing | `x-i18n: true`. `title` can be translated. `x-enumLabels` gives display names to the members of a scalar enum.                     |
| Derived    | `x-derive`. See [fields derived from the clock](./dynamic-dimensions.md#fields-derived-from-the-clock)                             |

Validation rules:

- An unsupported keyword is rejected, not ignored. This includes `$ref`, remote schemas, expressions and code.
- The initial value, the player's changes and the automatic updates all use the same validation. There is no type conversion, and no default value is filled in automatically.
- Size limits: a nesting depth of 32 levels, 10,000 nodes, and 256 KiB when serialized. The whole dimension table and the schema itself are also held to these limits, not only a single field.
- A single record written to plugin data (the value of one key) must be 256 KiB or less when serialized. Writes made during play have the same limit. A record over the limit gives an error, and the whole import fails. It is not cut short. When you need more content, split it into several records.

**Translation.** The main file is written in the default language. The translations go in [language files](#language-files-namelocaleext).

- `name` and `description` are the labels on the panel. They are shown in the player's interface language.
- Text inside values is not translated by default. Only a node that the schema marks with `x-i18n: true` can be translated.
- When a session is imported, these nodes and `updateRule` become plain text in the session's content language. A session stores only one language (see [Dynamic Dimensions](./dynamic-dimensions.md)).

For example:

```yaml
# data/dimensions.yaml
harborRumor:
  name: 港口传闻
  schema: { type: string, x-i18n: true }
  initialValue: 灯塔有人守夜。

# data/dimensions.en-US.yaml
harborRumor:
  name: Harbor Rumor
  initialValue: Someone keeps watch at the lighthouse.
```

`title` and `x-enumLabels` affect only how the panel shows the value. The value stays a stable enum ID, and the model, the rules and the validation all use the ID. The keys of `x-enumLabels` must be scalar members of the node's `enum`:

```yaml
# main file
schema:
  type: string
  title: 状态
  enum: [unverified, corroborated]
  x-enumLabels:
    unverified: 未核实
    corroborated: 已佐证

# language file: same path, text only
schema:
  title: Status
  x-enumLabels:
    unverified: Unverified
    corroborated: Corroborated
```

A dimension value that is read is always the raw value. Translation is applied only when the value is shown or queried, according to the labels above. A plain JSON value such as `{zh: 1, en: 2}` is not treated as a translation. IDs, property names and enum members are not translated.

#### Three ways for authors to declare dimensions

All three ways use the same declaration format. Pick one:

1. Write `dimensions` directly in `world.yaml`.
2. `dimensionSources`: each dimension ID points to one file (YAML or JSON, with a path relative to the world package root). The file holds the declaration for **that one** dimension.
3. One dimension file that holds the **whole dimension table**. When it is placed at `data/dimensions.yaml`, it is read by convention. When you use a descriptor, write `schema: covel://world/dimensions` and `to: world:metadata.dimensions`. See [Descriptor](#descriptor).

```yaml
# world.yaml; the content of data/reputation.yaml is the declaration under reputation in the example above
dimensionSources:
  reputation: data/reputation.yaml
```

When several of these are used together:

- A single item in `dimensionSources` overrides the declaration with the same ID in `world.yaml`.
- A source written to `world:metadata.dimensions` replaces the whole table, in load order.
- Only the final declarations go into a session. The ones that were overridden are not each initialized once.
- An external file can also have language files. Its path must not leave the world package either.
- If any declaration fails to read or validate, this load is thrown away, and the previous complete world stays in use.

#### Initialization, evolution and public reads

For world authors, these are the points to know:

- When a session is created, the final declarations and initial values are imported into the session. This is true no matter which way the declaration was written, and whether or not the world has a descriptor.
- The built-in plugin `world-init` handles initialization and maintenance on each turn. The framework finds the plugin that does this through the capability `world.dimensions@1`, not by plugin ID, so you can swap in another implementation.
- At the start of each turn, the narrative reads the values from the end of the previous turn. After the narrative ends, a model updates the values according to `updateRule` and the turn's story text. When there is no update rule at all, this model call is not made.
- The model decides the rules. The code checks the structure and the range. This is not an engine that settles results by formula.
- An update takes effect as one batch. If one change is invalid, none of the batch is written. A record is always left, even when nothing changed.
- When maintenance fails, does not run, or hits a conflict, the turn is marked as pending settlement (`pending-settlement`). Before the next narrative, you must retry it, confirm it by hand, or explicitly skip it.
- Large values are not put into the prompt in full. The prompt has a summary that fits a length budget. When the model needs more, it queries the built-in tools `world-dimension-list` and `world-dimension-get`.

Three places to read the current value (used when you write a plugin or a prompt template):

| Place            | How to write it                     |
| ---------------- | ----------------------------------- |
| Plugin code      | `ctx.world.dimensions.<id>.value`   |
| Prompt template  | `{{ world.dimensions.<id>.value }}` |
| Session snapshot | `dimensions.<id>.value`             |

Each item that is read includes the name, the description, the schema, the value and the version. It does not include the update rule or the initial value.

The player changes values through a dedicated entry point, not through the general plugin data write. For the timing, the five settlement states and the read and write boundaries, see [World Model](./world-model.md#dynamic-dimension-snapshot). For a call example, see [API](./api.md#dimension-editing-and-recovery-of-pending-settlements).

> [!NOTE]
> Characters, the inventory, affinity and time are still maintained by their own plugins. Do not store a second copy of them in dimensions. Dimensions are also not a mechanism for hidden plot. Not publishing an update rule does not keep the event content secret. For hidden content, use [hidden data](#hidden-data-visibility-hidden).

> [!IMPORTANT]
> Every dimension must be written in the declaration format above. A form that gives only a value (with no `schema` and no `initialValue`) is not accepted, and there is no automatic conversion. After you change the format, the affected development worlds, sessions and snapshots must be created again.

### AI-generated results and file export

The "AI create world" feature in the app and a world package written by hand use the same format. This section explains what a generated world looks like, and what developers who integrate `@covel/create` need to know.

**What is generated:**

- A new world is written in one language only. `defaultLocale` and the only entry in `supportedLocales` are both the requested language (the default is `zh-CN`). A translation that the model claims to have but did not really generate is not accepted.
- `characterSchema` and other valid manifest content are kept.
- When characters are added, the whole group of characters is validated against `characterSchema`. If it is still invalid after three attempts, that part is dropped, and a warning is returned.
- When an existing world is edited, all the characters after the merge are validated. If they are not valid, the whole package is retried, and if that also fails, the edit fails. Existing characters are never deleted quietly. The "one language only" rule for new worlds does not apply to edits.

**What the generated world package looks like:** it is laid out along the [convention paths](#import-by-convention-no-descriptor), the same as a hand-written one.

- Dimensions are in `data/dimensions.yaml`, characters are in `characters/characters.json`, and the lorebook and rules are in `data/lorebook.yaml`.
- There is one `WORLD.md` for the setting text, written in the world's own language (`defaultLocale` in `world.yaml`). A `WORLD.<locale>.md` is a translation, and a new world does not have one.
- When every file is at a convention path, no descriptor is written, and `world.yaml` has no `worldData`.

**Plugin content** is specified by the `contracts` in the creation brief:

- The generator makes records only for the data contracts that are chosen. The schema, the writing prompt and the example of each contract come from the `authoring` declaration of the receiving plugin (it must declare `generate`). The receiving plugin is added to `pluginPolicy.requested`.
- A contract that is not chosen does not go into the prompt. If the model outputs records for a contract that was not chosen, or leaves out a contract that was chosen, that attempt counts as a failure and is retried.
- The records of a contract are written to the file that the receiving plugin declares (the `path` and `kind` of `authoring.source`, for example `data/memory-blocks.json` or `data/time.yaml`). One record is the file content. Several records are written as an array.
- In the two cases below, the records are rewritten to `data/contract-<n>.json`, and the descriptor `data/world.data.yaml` lists every source:
  - The receiving plugin does not declare a path.
  - The declared path cannot be used as a convention. Either another contract in an installed plugin declares the same path, or the path is one of the world package's own files (`world.yaml`, `WORLD.md`, or the kernel's data files).
- When the receiver declares a lorebook projection, the target is written as `contract:<id>+lorebook`.

**The `@covel/create` interface:**

- `createWorld({ llm, concept, ... })` generates the content and validates it. On success it returns `id`, `manifest`, `lore`, `locale`, `packageContent` and `warnings`. On failure it returns `success: false` and `errors`. `warnings` include content below the brief's target count and invalid dimensions that were dropped.
- The returned `manifest` has already been validated against the schema and normalized. It includes the canonical form of the locale and defaults such as `characterSchema.types`. All three save targets use the same result.
- Generation does not write files, and it does not accept `outputDir`. A generated manifest must put its data inside the manifest. It cannot refer to a `worldData` or `dimensionSources` file that has not been generated.
- The `memoryDefinitions` from the brief are converted into `memory.blocks@1/world` records in `packageContent.contractData`. Writing files and not writing files use the same data. Declaring the same target twice is rejected.
- To get a package of files, call `await writeWorldPackage(outputDir, result, { dataContracts })` explicitly. It returns the relative paths that were written. It works on a separate copy, converting the data in the manifest into file references, and the original result does not change. An existing package with the same name is rejected. When two writes go to the same package at once, only one succeeds.

**Worlds without a folder.** A world saved in the server database (`server-store`) or in the browser's local storage has no package folder that can be read later. In that case:

- Common characters go into `WorldRecord.metadata.embeddedCharacters`, and the lorebook and rules go into `WorldRecord.metadata.embeddedLorebook`.
- When a session is created, this content is used only when there is no world data in the form of imported files. So the same world is never imported twice.
- This form holds only text. Images still need a media source, real files and a content-addressed index.

> [!NOTE]
> The root folder of a world package written by the generator contains a `.covel-generated.json` file. It lists every file the app wrote into the package, and the world record gets `metadata.generated: true` because of it. While the package holds only those files and their content is unchanged, the app can rewrite the whole package when the player asks (`POST /api/ai/revise-world`). After you add a portrait or other files by hand, or edit a generated file, "Revise this world" refuses to rewrite the package and names those files. The package stays as it is. Edit the files of the package directly from then on. To use "Revise this world" again, undo those changes first.

### Built-in example worlds

A world package does not have to use every capability. Let the genre decide the plugin mix and the data. The four worlds in the repository show different mixes:

| Example                 | Player experience                                                                           | Main capabilities                                                                                                                                                                                                                                                                                                                                                                           | Files to look at                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | A dark fantasy investigation, for players who want a heavy story                            | The `mistport-investigation` mix. Evolving dimensions 案情板 (case board), 四方立场 (four sides), 深退潮 (deep ebb) and 钥匙碎片 (key fragments). Hidden events with `visibility: hidden` (`story-events`). Lore, characters, rules and presence by language. Character attribute schema, portraits, and rules for tides and factions.                                                      | `world.yaml`, `WORLD.md` / `WORLD.en-US.md`, `data/dimensions.yaml`, `data/rules/`, `characters/`, `media/`                        |
| `worlds/haruka-academy` | Campus romance with a group of characters (GalGame), with a dialogue and visual novel stage | The `haruka-galgame` mix (stage, multiple replies, affinity). `defaultViewMode: stage`. Affinity seeds and evolving dimensions 心之路线 (heart routes), 学园祭筹备 (festival preparation), 文艺部存续审查 (club review), 约定 (promises) and 校园传闻 (campus rumors). Hidden personal-route events and their follow-ups. Transparent portraits, and a day and night scene registry.        | `world.yaml`, `WORLD.md`, `data/dimensions.yaml`, `data/affinity.yaml`, `data/rules/`, `characters/`, `media/scenes.registry.json` |
| `worlds/emberback`      | English science fiction rescue, with RPG resources and quest progress                       | The `emberback-rescue` mix. Dice checks, quests, items and affinity seeds. Evolving dimensions Crownfire Countdown, Relay Grid, Signal Log and Medical Convoy. Hidden events and event chains.                                                                                                                                                                                              | `data/dimensions.yaml`, `data/quests.yaml`, `data/items.yaml`, `data/affinity.yaml`, `characters/`                                 |
| `worlds/lantern-barrow` | Classic tabletop dungeon exploration (Chinese and English)                                  | The `classic-tabletop` mix. Starting point buy from `tabletop-rules` (`contract:tabletop-rules.rules.initial@1`), form checks and the `dice-check` dice pool. `.en-US` variants of quests, items and affinity. Evolving dimensions 古冢地图 (tomb map), 古冢警戒 (tomb alert), 古冢之灯 (tomb lantern) and 名望 (renown). Hidden encounters and event chains (including `.en-US` variants). | `world.yaml`, `WORLD.md` / `WORLD.en-US.md`, `data/tabletop-rules.json`, `data/*.en-US.yaml`, `characters/*.en-US.json`            |

- Mistport, Haruka Academy (遥风学园) and Lantern Barrow (提灯古冢) list their sources in `data/world.data.yaml`. Emberback has no descriptor and is read from its convention paths. Both ways have the same effect.
- All four worlds enable `story-events`. Mistport, Emberback and Lantern Barrow also turn on story planning with `pluginSettings.story-events.planner: true`. Besides the hidden events the author sets up, it adds follow-up events that fire only once, based on clues left during play. Haruka Academy's romance routes are arranged one by one by the author, and it does not turn on story planning.
- When you make a new world, first copy the structure of the world whose gameplay is closest to yours. Then add or remove characters, rules or media by following the sections below.

### Display fields

These fields change only how the world is shown. You can leave all of them out.

- `defaultViewMode`: the default way to show the session the first time it is played. Write `stage` (full-screen stage mode, see [ui-panels.md](./ui-panels.md#stage-mode-stage-view)) or `parsed`. It is only the starting value. Once the player switches the view at the top of the page, the player's choice wins.
- `version`, `author`, `license`, `homepage`: the version and author information of the world package. The fields, limits and translation rules are the same as for plugins. See [author information](./plugins.md#author-information). They show only on the world card. They do not go into session data or the prompt.
- `cover`, `accentColor`, `themeMusic`: the cover, the accent color, and the music on the world list. See the end of the [Background Music](#background-music) section.

### Plugin selection (`pluginPolicy`)

`pluginPolicy` says which plugins this world would like to use. It does not lock in any plugin. Which ones are finally on is worked out by Covel, from the capabilities and dependencies each plugin declares, the player's authorization, and the player's own checkboxes.

| Field                           | Description                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `presetId`                      | The ID of the default pack. It can refer to a `packs[].id` or a built-in pack.                                           |
| `preferredTags` / `avoidedTags` | Plugin tag preferences                                                                                                   |
| `requires`                      | Contract IDs the world needs (such as `action-check@1`). Any installed plugin that provides the contract can satisfy it. |
| `requested`                     | Plugin IDs the world suggests as the starting selection                                                                  |
| `recommended`                   | Plugin IDs suggested in addition                                                                                         |
| `packs`                         | Custom packs. Each item has `id/label`, and can optionally have `description/requested/recommended/tags/reason`.         |

`presetId` must be the ID of a built-in pack or of one of this world's `packs`. Otherwise `pnpm validate:world` reports `unknown-preset`.

`requires` says "what capability this world cannot do without". Write a contract here (a capability name plus a version), not a plugin:

```yaml
pluginPolicy:
  requires:
    - action-check@1 # action checks; the built-in dice-check provides it, and you can use another check plugin
  requested:
    - dice-check # optional: the starting selection, and it chooses which provider to use when there are several
```

- When only one installed plugin provides it, that plugin is turned on automatically.
- When there is no provider, or there are several and neither the world nor the player has chosen one, the session-prep screen explains why and disables the start button.
- The player can still turn off a provider. That is the player's choice. The session starts as usual, and the session-prep screen shows a notice.
- `requires` accepts only contract IDs in the form `name@version`. A plugin ID written here causes an error when the world loads.

`requested` holds plugin IDs. The plugin may not be installed on the player's computer:

- `GET /api/worlds/:id/plugin-plan` removes the IDs that are not installed from the world policy and from each pack's `requested`. They are listed in `missing` instead (for packs, with a `packId`).
- The session-prep screen uses this to show which plugins are missing. The session can still be created, but the gameplay those plugins provide will not work.
- `recommended` does not take part in the default selection. It is returned as it is.

### Loading at startup and reconciling (seed & reconcile)

When the server starts, each world package in the world directories is written into the database. This step is called seed.

**Reading order:**

1. The built-in directory: `COVEL_WORLDS_DIR`. When running from source, the default is the repository's `worlds/`.
2. The user directory: `COVEL_USER_WORLDS_DIR`. If it is not set, it is `$COVEL_HOME/worlds`. If `COVEL_HOME` is not set either, it is `~/.covel/worlds`. The desktop app uses `<data_root>/worlds`.

Seed can run again and again. Each world package has one world record. If the record exists, it is updated. If not, it is added, and it is marked with `metadata.source = "file"`. Seed itself never deletes anything.

**Cleanup (reconcile).** Adding without ever deleting leaves one problem. A world that was once built in, and later removed from the packages, would stay in the database of older users. So after all the directories have been seeded, old records that are "no longer in any world directory" are deleted. Three safeguards make sure only that kind of record is cleaned up, and no user data is deleted by mistake:

1. **Only the source is checked**: only worlds with `metadata.source === "file"` can be cleaned up. AI-generated worlds (`generated` / `generated-file`) and worlds from any other source are never touched, even when they are not in the current world directories.
2. **A world with saved games is kept**: an old world that still has sessions is kept, not deleted, and a `warn` line is written to the log. Deleting a world that has saved games must be an explicit action by a person.
3. **An incomplete scan means no cleanup**: if any world directory cannot be scanned, if any world package fails to read, parse or validate, or if not a single world loaded successfully, cleanup is skipped as a whole. Healthy worlds are still updated as usual.

A user worlds directory that does not exist counts as an empty directory; bundled worlds still refresh. Other directory read errors still make the scan incomplete.

> [!NOTE]
> To remove a built-in world that **still has saved games**, you must explicitly delete its world record and the sessions linked to it.

**When several directories have the same ID:**

- The later directory wins (the user directory wins over the built-in directory). The package that is covered does not rewrite the world record, and it does not notify sessions.
- A duplicate ID inside one directory causes an error, and those packages are not written to the database.
- When the winning package's manifest or dimensions do not load completely, the existing record is kept and cleanup is skipped. The covered package is not used in its place.
- Finding worlds looks only at the direct subfolders of a directory. A package whose manifest is a symbolic link is rejected. Hidden temporary directories are ignored.
- The folder name does not have to match the `id`. Creating a session, the preflight check and data sync all find a world package by the `id` in its manifest.

**Browser local storage.** When the browser's private storage is used, worlds are kept in the browser:

- The first time an empty database is initialized, the full catalog is imported from `GET /api/worlds`. It keeps the manifest ID, the lore, the dimensions, the characters and the package information.
- If the catalog request fails, initialization is not counted as done, and it can be retried. Getting an empty catalog successfully is a valid result.
- After initialization, the worlds in the browser are managed only by local edits and deletes. Later starts do not request the catalog again and do not overwrite anything automatically, and the worlds can be read offline. Existing local worlds are never overwritten by initialization.
- Later changes in the server catalog do not update these copies automatically.

### Updating files and installing

**Where installs go.** An installed world package, and an AI-generated world that was saved as files, are both written to the user world directory. The built-in directory is never changed.

- After a successful install, the world appears in the world list at once. No restart is needed (the API returns `restartRequired: false`).
- If activation fails, only the folder created for this install is removed. You can try again.
- A ZIP install validates the world data first. If there is an error-level problem (a missing descriptor or source, a file that cannot be parsed, or data that does not match its own schema), it returns 400, creates no world record, and removes the folder created for this install. After you fix the problem, you can retry with the same ID. Warnings do not stop an install.
- This check reads only the data in the package. A local override cannot hide errors in the package, and it does not run community code.
- The seed at startup is not affected by this. A package with bad world data is loaded with the old, lenient behavior.

For installing and updating from GitHub, see [world catalog and installation](./world-installation.md).

**Automatic reload after a file change.** The server watches the built-in and user world directories (including on Linux).

- After a file in a world package changes, Covel waits 500 milliseconds to combine a run of changes, and then reads the package again. Changes to images, audio and editor temporary files do not trigger a reload. Changes to `world.yaml`, `WORLD.md`, language versions, `data/`, `characters/`, `media/*.json` and similar files do trigger one.
- After reading, Covel finds the world by the manifest's `id`. If anything is different, it updates the world record and writes to the log what was reloaded: the lore, the name and summary, the dimensions, the plugin policy and settings, and the world data and settings.
- If the manifest or the lore cannot be read, a warning is logged, and the version already loaded keeps being used.
- A world that a player has edited in the app (`packageModified`) keeps the edited copy. File changes do not overwrite it.
- A reload does not change the world's source or its creation time. An AI-generated world does not turn into a built-in world that cannot be deleted just because it was reloaded.

**What a reload affects:**

| Target                    | Result                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New sessions              | Read the latest world package                                                                                                                                                     |
| Lore of existing sessions | The next turn reads the new lore. A session that has its own `loreOverride` keeps using it.                                                                                       |
| Data of existing sessions | Characters, lorebook entries, dimension values and states that have already happened are not rewritten. To use new data, start a new session, or use [sync](#preflight-and-sync). |

- When a dimension declaration changes, sessions that use this world receive `world.dimensions.changed`. This is only a notice. A value that has already changed in a session is not reset to the new initial value. You must sync it on purpose and deal with any conflicts.
- This is not a hot update of the whole package. Putting a **new** world folder into the directory only makes it appear after a restart, or through the install entry point. A plugin install also still needs a server restart.
- When the file system does not support watching, a warning is logged at startup. Dimensions can also be imported through `POST /api/worlds/:id/dimensions/import`.
- The implementation is in `apps/server/src/world-file-watcher.ts`. For the install response, see [API reference](./api.md#installed-resource-storage-and-vector-configuration).

**Every dimension file must be readable.** Files in `dimensionSources` and worldData sources targeting `world:metadata.dimensions` follow the same rule. If any one file is missing, cannot be read, has a YAML error, or fails validation, the whole world fails to load this time. The previous complete record is kept, no dimension-change notice is sent, and the old world is not cleaned up. Automatic reloading continues once the file is fixed.

**Deleting an AI-generated world that was saved as files (`generated-file`):**

- First, check `metadata.storage.path` in the configured world directories. Then find the one world package in that directory that matches the manifest ID. When an old record has no storage location, it must match exactly one package across all directories.
- When the location is invalid, the package is missing, or there is more than one candidate, the API returns `409 world_package_unresolved`. Neither the files nor the database record are deleted. It never falls back to deleting a package with the same name in another directory.
- When deleting, the package is first moved to a temporary location in the same directory, and then the database record is deleted. If the database step fails, the folder is moved back, and you can retry.
- After success, a failure to clean up the temporary files is only logged. That temporary location is never loaded again as a world.
- This only makes sure things can be recovered when an error happens inside the running process. If the process crashes between the two steps, the files and the database are not guaranteed to match.

**What stays the same when a world record is edited:**

- The world's `metadata.source` and `metadata.storage` keep their original values through a normal update request (PATCH). Editing or browser sync does not change which files the world belongs to.
- Dimensions follow `metadata.dimensions`. The top-level `dimensions` is a way to read the same content. When only top-level dimensions are given, they are written to `metadata.dimensions`. When `metadata.dimensions` is replaced or cleared, the top level is updated too. All three database backends behave the same way.

### Default plugin settings (`pluginSettings`)

At the top level of `world.yaml` (at the same level as `pluginPolicy`), you can write `pluginSettings` to preset **this world's default values** for plugin settings. The format is `plugin ID → setting → value`:

```yaml
pluginSettings:
  story-events:
    planner: true
  chat-mode-narrator:
    dialogueRatio: 70
```

The value of a setting is decided in this order. The earlier item wins:

1. The value the player set in the settings.
2. The world's `pluginSettings`.
3. The default that the plugin declares for itself (`contributes.settings[].default`).

- The player can still override every value.
- A setting that the plugin does not declare does not cause an error. It just has no effect. `pnpm validate:world` gives an `unknown-setting` reminder. A value with the wrong type, range or options gives an `invalid-setting` error.
- `pluginSettings` sets only default values. It does not decide which plugins are turned on. That is decided by [`pluginPolicy`](#plugin-selection-pluginpolicy).

For plugin authors: after loading, the value is stored in `WorldRecord.metadata.pluginSettings`. At the start of each turn, it is merged with the player's values (the request header `X-Plugin-User-Settings`) and put into `TurnInput.userSettings`. The agent's `{{ userSettings.* }}`, the guards and the hooks all read the same data.

### World memory definitions (`memory.blocks@1`)

Memory definitions tell the `memory` plugin which kinds of things this world should remember over the long term, such as clues and promises. They are imported like any other plugin data. `data/memory-blocks.json` is **one object**, with `id` fixed to `world`. It is not an array:

```json
{
  "id": "world",
  "blocks": [
    {
      "label": "clues",
      "displayName": { "zh-CN": "线索", "en-US": "Clues" },
      "extractionHint": {
        "zh-CN": "记录已发现的线索及关联。",
        "en-US": "Track discovered clues and their connections."
      },
      "icon": "Search",
      "maxChars": 1200
    }
  ]
}
```

When the file is at `data/memory-blocks.json`, it is read by convention. When you use a descriptor, write it like this:

```yaml
schemaVersion: 1
sources:
  memory-definitions:
    kind: json
    path: data/memory-blocks.json
    schema: contract:memory.blocks@1
    to: contract:memory.blocks@1
    key: id
```

- `label` must match `^[a-z][a-z0-9_]*$`.
- `displayName` and `extractionHint` can be written separately for each language. `maxChars` is a positive integer.
- The definitions load in this order: the base definitions fixed by the plugin, then the definitions that other enabled plugins provide (the `memory.block-definitions@1` service), and last the world's definitions. When a `label` is already taken, the one loaded first is kept.
- The object is imported into the `definitions/world` record of the `memory` plugin itself. The memory content is stored in that plugin's `blocks`, and the plugin puts it into the prompt. `world.yaml` has no dedicated field for memory definitions.
- All four built-in worlds use this file.

## Import by convention (no descriptor)

When `world.yaml` has no `worldData` field, the world package is read by convention. If a file (or, for media, a directory) exists at a convention path, it is a source. The effect is exactly the same as writing the same entry in a descriptor.

The conventions come from two places:

- **Kernel**:
  - `data/dimensions.yaml` → dimensions (`world:metadata.dimensions`)
  - `data/lorebook.yaml` → lorebook (`lorebook`)
  - `characters/characters.json` → characters (`characters`)
- **Plugins**: the `kind` / `path` / `key` that each data contract declares in `contributes.data.<ns>.authoring.source`. `pnpm describe:authoring` lists all of them. For example:

```text
### Starting quests — `quests@1` (plugin `core-quest`)

Importable quest records — world packs may preseed main/side quests; the quest log advances them by name.

How to write it: Seed the main quest and, at most, a few side quests. `status` is `active`, `completed` or `failed`. Each objective has `text` and `done`; give it an `id` so later updates can address it. The quest log advances quests by name, so use the quest and giver names that the lore uses.

Put the file at `data/quests.yaml`: it is imported without a descriptor. The same source in a descriptor:

    quests:
      kind: yaml
      path: data/quests.yaml
      schema: contract:quests@1
      to: contract:quests@1
      key: id
```

Rules:

- The import order is: dimensions, then media, then the other contract data, and last `characters`.
- The built-in world `worlds/emberback` is read this way. It has no descriptor, and all 13 of its sources come from convention paths.
- With no descriptor, the conventions of the **installed** plugins are used. With a descriptor, only the sources it lists are read.

For plugin authors: `path` is a path relative to the world package root. It can contain only ASCII letters, digits, `_`, `.`, `/` and `-`. It cannot start with `/`, and it cannot contain `..`. A plugin manifest that does not follow this fails validation when it loads. When two contracts declare the same path, that path is not a convention, and the world package must use a descriptor to say which one it is for.

**When you still need a descriptor:**

- The file is not at a convention path. For example, a rules file is named `data/rules/tide-mystery.yaml`, or you want a file name in Chinese.
- One contract has several files.
- You need to set the order with `after`.
- You want to turn off a source.

> [!IMPORTANT]
> Once `worldData` is written, only the descriptor is used, and the conventions no longer apply. The descriptor must list every source.

**Unused files.** `pnpm validate:world` checks whether any file in `data/`, `characters/` and `media/` (including subfolders) is not used by any source or framework feature. If one is not, it gives a `data-file-unused` reminder. Both import methods are checked. Language files of a source that already exists, local schemas, dimension files, theme music and gallery images are not reported by mistake. A README is author documentation and is not checked.

## Descriptor

The descriptor is a YAML file, usually called `data/world.data.yaml`. It lists each piece of data in `sources`:

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions

  cast:
    kind: json
    path: characters/main-cast.json
    to: contract:character.blueprints@1
    key: id
    after: dimensions

  characters:
    kind: json
    path: characters/characters.json
    to: characters
    key: id
    after: cast
```

The fields you use most often in each source:

| Field    | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| `kind`   | File type: `yaml`, `json`, `markdown`, `text`, or `media`             |
| `path`   | A file or a directory, relative to the world package root             |
| `to`     | Where the data goes. See [Target URI](#target-uri).                   |
| `key`    | The field in each record that is used as its unique ID. Usually `id`. |
| `after`  | The source that this one must be imported after                       |
| `schema` | What to validate against. Usually you can leave it out (see below).   |

For a field-by-field explanation, see the generated [World data descriptor field table](./schema/world-data-descriptor.md).

- The name of a source (the key under `sources`) must match `^[a-z][a-zA-Z0-9_-]{0,63}$`.
- At the top level, the descriptor currently accepts only `schemaVersion: 1` and `sources`.

**When to write `schema`:**

- When the target is `contract:<id>` (including `+lorebook`), the data is checked against that contract's schema. You can leave it out.
- When the target is `world:metadata.dimensions`, the data is checked against the dimension schema. You can leave it out.
- You need it only when you want to check against a JSON Schema file in the world package.
- When it is left out and no plugin declares a schema for the contract, that source is not checked. When you write `schema: contract:<id>` and no schema can be found, that is an error.

**Media sources** need both `key: filename` and `indexTo: contract:<contractId>`:

- A missing `key` is an error.
- Without `indexTo`, nothing records which images exist, so these files are not imported.
- When the plugin that receives the image index is not enabled, the files of this source are not imported either. This is a warning, and it does not affect other data. If you enable the receiving plugin later, run [sync](#preflight-and-sync) to import them.

### Images visible before a session

The images in a world package can be seen by the player before a session is created. The world list and the world detail page read them directly from the world package through `GET /api/worlds/:id/gallery`.

- When the world package has `media/gallery.json`, the images and descriptions in that manifest are shown, up to the `spoilerLevel: opening` level only.
- When it does not, the images in the public `kind: media` sources are shown. Sources with `enabled: false` or `visibility: hidden` are not included.

For the API and the display rules, see [api.md](./api.md) and [world art direction](../worlds/art-direction.md#gallery-data-and-front-end-use).

### Hidden data (`visibility: hidden`)

A source is public by default. A source with `visibility: hidden` holds content that must not be known until a condition is met, such as hidden plot.

- It can be given only to a plugin (`to: contract:<contractId>`).
- After import, it is kept in a separate hidden area of the receiving plugin, `_hidden.<namespace>`. For example, `events` of `story-events` maps to `_hidden.events`.

```yaml
sources:
  storyEvents:
    kind: yaml
    path: data/hidden/story-events.yaml
    schema: contract:story.events@1
    to: contract:story.events@1
    key: id
    visibility: hidden
```

The framework makes sure hidden data does not leak through these outlets:

| Outlet                   | How it is handled                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt                   | Injecting a hidden namespace with `io.selfData` causes an error. `ctx.pluginData` in the extension points (`prompt.segment@1`, `ui.slot@1`, `session.world-context@1`) cannot read hidden data.                                                           |
| Model tools              | The built-in `plugin-data-get` / `plugin-data-list` do not return hidden namespaces.                                                                                                                                                                      |
| Player-facing API        | The plugin data API, the `/state` data panel and discovery do not list hidden data, and a single read returns 404. Snapshot read APIs (`GET` / `POST /snapshots`) also remove hidden namespaces from their responses. Snapshots in storage stay complete. |
| Lorebook and projections | `+lorebook` is not allowed. `worldProjections` skip hidden sources.                                                                                                                                                                                       |
| Other targets            | `characters`, `lorebook`, `world:metadata.*`, media and `indexTo` are all rejected.                                                                                                                                                                       |
| Writes                   | The REST API and the built-in `plugin-data-set` tool cannot write it. Only the owning plugin's own code (function runtimes and the plugin's local tools) can write to its own `_hidden.*`.                                                                |

Only the receiving plugin's own code can read hidden data. When the plugin decides to reveal it:

- It gives the content, during this turn, to the party that needs it (usually the narrative).
- It leaves a reveal record in the public data that does not contain the original text.

The built-in [`story-events`](./plugins.md) does this. Once revealed, the content is an input to the narrative for this turn, and it appears in the narrative's execution details.

> [!WARNING]
> Hidden data is meant to prevent spoilers, not to encrypt anything. The world package files are on the player's own computer. In browser local mode, saved progress also holds this data so that it can run. Do not put information that really must stay secret into a world package.

#### Hidden content added during play

Hidden content can also be created during play. A runtime publishes output with a contract, and the receiving plugin validates it and writes it into its own `_hidden.<namespace>`.

A runtime that handles this content must declare `io.concealed: true`. Then its prompts, tool arguments, results and output do not go into traces, the live stream, `/view`, `/turns`, or the return values of manual RPC.

The built-in chain works like this:

1. `story-events/plot` (an agent, post-turn, runs every 3 turns, and runs when the `planner` setting is on) reads the world summary, the protagonist, this turn's narrative, the optional WorldIR extraction for this turn, the dimension values, the world time, and the ledger that `evaluate` makes public. The ledger holds only the IDs and titles of events that have happened and events that have been set up. It does not include the world author's events that have not happened yet. It then calls `plan-story-events` to publish `story-event.plan@1`.
2. `story-events/intake` (a function, post-turn) validates each plan:
   - Whether the structure of each event is correct.
   - Whether the dimensions, time fields and events it refers to exist.
   - It cannot overwrite the world author's events or events that have already happened.
   - At most 8 planned events can be waiting at the same time.

   An event that passes is written to `_hidden.planned`, and it fires only once.

3. `story-events/evaluate` evaluates both `_hidden.events` and `_hidden.planned` on every turn. When a condition is met, it is handed to the narrative as usual.

Planned events and author events are kept in different hidden areas, so syncing world data does not overwrite planned events.

### Language files (`<name>.<locale>.<ext>`)

**The main file is written in one language only**, the `defaultLocale` in `world.yaml`. Other languages go in `<name>.<locale>.<ext>` next to the main file. They hold only the translated text and do not repeat the structure.

```text
world.yaml                     # main file, text in defaultLocale
world.en-US.yaml               # English translation only
data/dimensions.yaml
data/dimensions.en-US.yaml
characters/main-cast.json
characters/main-cast.en-US.json
WORLD.md
WORLD.en-US.md                 # lore-type files have no id to line up on, so the whole file is replaced
```

```yaml
# world.yaml
name: 雾港・裂潮纪
characterSchema:
  attributes:
    - id: fogRot
      name: 雾蚀
      type: number

# world.en-US.yaml —— text only
name: Mistport Chronicles
characterSchema:
  attributes:
    - id: fogRot
      name: Fog Rot
```

**File names:**

- `<locale>` must be the full form written in `supportedLocales`. If the world declares `en-US`, the file is named `….en-US.…`. If the world declares `fr`, the exact name is `….fr.…`.
- A language-only file such as `….en.…` is not read. Covel does not guess that `en` should be used when the session is `en-US`.
  - `pnpm validate:world` reports a `locale-file-name` error and gives the file name it should have.
  - When the server loads the world, it writes the file name and the correct name to the log.
  - When an installed or imported community world has this problem, it is rejected with 400 and the same explanation.
- `<locale>` must be a real language tag (`en-US`, `zh-Hant`). `items.backup.yaml` is not treated as a language file.
- Fallback between session languages is not affected. For example, a session in `zh-TW` reads the `zh-CN` version. This chooses among the versions that the world really has.

**How a translation lines up with the main file:**

- Objects are matched by key.
- Lists of objects are matched first by the source's `key`, and then by `id`. A source can use `localeArrayKeys` to declare extra stable fields in nested lists (for example `localeArrayKeys: [label]`). For each list, the first field that every element has is used, and the translation must keep it. This way, inserting, deleting or reordering items in the main file does not put a translation in the wrong place. Without these fields, items are matched by position.
- A field used for matching is not translated, even when it is Chinese or looks like display text. The translation tools do not extract it either. A field with the same name in other places can still be translated.
- A language file can translate only text that already exists in the main file. A key or ID that is not in the main file, text in a place that is not text, or a changed number or boolean is ignored and reported, and the main file's value is kept.
- Text that is not translated falls back to the main file, so you can translate a little at a time.
- A language file holds only the fields used for matching and the translations. Do not copy things that change, such as media hashes and paths.
- A plain text list (for example aliases) is translated as a whole. The list in the language file replaces the list in the main file. An item written as `null` means "use the main file's value".

**How the three kinds of file are read:**

| File                                                                                                                | How it is read                                                                                                                      | Result                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `world.yaml`, dimension definitions (files in `dimensionSources`, and sources with `to: world:metadata.dimensions`) | All language files are read together                                                                                                | Text carries all the languages. The world list and the panel labels are shown in the UI language. |
| Other structured sources (JSON / YAML)                                                                              | Only the one copy that matches the session language is merged. The locale in the file name must match the session language exactly. | Single-language data. Sessions do not store several languages.                                    |
| `markdown` / `text` / `media`                                                                                       | A language file replaces the main file as a whole                                                                                   | Same as above                                                                                     |

Other rules:

- The session language is fixed when the session is created, and it is always a version the world declares. The file name must match it exactly. `zh-Hant-TW` does not read the `zh` file.
- Language files are part of a source. Changing any one of them counts as the source changing, and [sync](#preflight-and-sync) can see that.
- A main file cannot write text as a multi-language map (`name: { zh-CN: …, en-US: … }`). `pnpm validate:world` reports this as an `inline-locale-map` error. A world package written this way must be split into a main file and language files.
- In dimension values, only a text node that the schema marks with `x-i18n: true` can be translated. Translating any other node makes validation of that dimension fail.

For plugin authors: the merge rule is `applyLocaleOverlay` in `@covel/shared`. The `locale` option of `importWorldDataForSession`, `syncWorldDataForSession` and `preflightWorldDataForSession` is passed in as it is. When it is left out, `session.locale` is used.

## Target URI

`to` says where the data goes. These are supported now:

| URI                              | When it is imported       | Description                                                                                                     |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `world:metadata.<path>`          | When the world loads      | Written to a sub-path of the world record's `metadata`. For now, only `world:metadata.dimensions` takes effect. |
| `contract:<contractId>`          | When a session is created | Given to every enabled plugin that declares it accepts this contract                                            |
| `contract:<contractId>+lorebook` | When a session is created | The same, and also creates one entry in the session's lorebook at the same time                                 |
| `lorebook`                       | When a session is created | Written straight into the session's lorebook                                                                    |
| `characters`                     | When a session is created | Writes general character records into the session                                                               |
| `media` + `indexTo`              | When a session is created | Imports media files, and gives the index to the plugin named by `indexTo`                                       |

- A media source uses `to: media` with `indexTo` in contract form. A structured source cannot set `to` to `media`. This kind of wrong combination is rejected during validation.
- A path in `world:metadata.<path>` cannot contain dangerous segments such as `__proto__`. Paths other than `dimensions` are only recorded for now, and they have no effect.
- World data is imported when a session is created. Existing sessions must be synced through [`sync-data`](#preflight-and-sync). Calling `preflight` first lets you see the diagnostics before anything is written.

### Lorebook entries injected by player message

A lorebook is good for a large amount of setting material. An entry enters the prompt only when the player mentions a related keyword, so it does not take up space on every turn.

When the file is at `data/lorebook.yaml`, it is read by convention. When a world uses a descriptor, write it like this:

```yaml
# world.yaml
worldData: data/world.data.yaml
```

```yaml
# data/world.data.yaml
schemaVersion: 1
sources:
  lore:
    kind: yaml
    path: data/lorebook.yaml
    to: lorebook
    key: id
```

```yaml
# data/lorebook.yaml
- id: dragons
  content: 龙族是远古时代最强大的种族……
  strategy: selective
  keys: [龙族, 龙鳞, Drakon]

- id: core-rules
  content: 本世界的魔法必须遵守等价交换。
  strategy: constant
```

Fields of an entry:

| Field             | Description                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | The ID of the entry                                                                                                                                                              |
| `content`         | The text. Required, and it cannot be empty.                                                                                                                                      |
| `strategy`        | `constant` (injected on every turn) or `selective` (injected only when a keyword matches). The default is `constant`.                                                            |
| `kind`            | Another way to write it: `constant` or `triggered` (the same as `selective`)                                                                                                     |
| `keys`            | A list of keywords. A `selective` entry must have a non-empty `keys`.                                                                                                            |
| `position`        | Where it is inserted. The default is `after_plugin`.                                                                                                                             |
| `insertionOrder`  | A number used for ordering. The default is 100.                                                                                                                                  |
| `enabled`         | The default is `true`.                                                                                                                                                           |
| `extra.scanDepth` | How many earlier committed messages of the conversation to look back at, besides the current player message (this includes compressed messages). From 0 to 20. The default is 0. |

Matching rules:

- A `selective` entry checks the current player message, and the most recent conversation messages set by `extra.scanDepth`.
- Keywords in the Latin alphabet match whole words, and they accept plural and possessive endings. `lantern` also matches `lanterns` and `lantern's`, but not `lanternfish`.
- Keywords in Chinese, Japanese and Korean match as substrings.
- Matching is not case sensitive.
- A `selective` entry without `keys` is rejected by both the static validation and the import preflight.

Other points:

- An entry imported from a world package belongs to the world. An entry is identified by three things together: the session, the owner and the ID. So it does not overwrite an entry with the same ID that a player or a plugin created.
- A Markdown link in `PLUGIN.md` does not make Covel load a file. `references/*.md` and the custom `keywords` in them are not part of the plugin runtime.

### Contract resolution and preflight

`contract:<contractId>` can appear in three places: `schema`, `to`, and the `indexTo` of a media source.

- A contract ID matches `^[a-z][a-z0-9.-]*@[1-9][0-9]*$`, for example `character.blueprints@1`.
- `+lorebook` can be used only in `to`. It creates one extra lorebook entry that belongs to the world. When there are several receiving plugins, it still creates only one entry.

**How the schema and the receivers are found:**

- `schema` is looked up in `contracts.<id>.schema` in the root of a registered plugin. The file is in that plugin's folder.
- `to` matches `contributes.data.<namespace>.accepts` in the plugin root. It is written to each enabled receiver in a fixed order.
- These are two separate checks. The data first passes the source's schema, and then each receiver's own schema.

**Results:**

| Case                                                                                            | Result                                                                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No registered plugin receives this contract                                                     | Error. This is the author's mistake.                                                      |
| Some plugin receives it, but none is enabled in this game                                       | Warning. Only the write for this contract is skipped. Other sources are handled as usual. |
| Several enabled receivers                                                                       | Each one gets a copy. The data is not tied to a specific plugin ID.                       |
| A missing schema, a path that leaves the world package, an unreadable file, or an invalid value | Error. The import is blocked.                                                             |

Built-in schemas and schemas local to the world package are checked when the world loads. A contract's schema depends on which plugins are installed, so it is checked when a session is created or during preflight.

## WorldIR and plugin projections

This section is for plugin authors. World authors usually do not need it.

`contract:world-ir@1` is a neutral format published by the `world-ir` plugin, used to describe the facts of a world. It lets a world author, or an upstream extraction step, maintain one set of world facts. Each plugin then turns that same input into its own data.

In v1, the top level and each kind of record reject unknown fields. Plugin-specific content can go only in `attributes`:

```yaml
schemaVersion: 1
summary: 海滨校园中的人物、事件与规则。
entities: []
relations: []
events: []
statements:
  - id: school-closing-time
    type: rule
    content: 学校每天十八点闭校。
    attributes:
      title: 闭校时间
      kind: constant
```

The four arrays are always present:

| Array        | Required fields            | Use                                                                                                               |
| ------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `entities`   | `id`, `type`               | Stable entities such as people, places, organizations and items. Can have `name`, `description` and `attributes`. |
| `relations`  | `id`, `type`, `from`, `to` | Directed relations between entities. Can have `description` and `attributes`.                                     |
| `events`     | `id`, `type`               | Events. Can have `participantIds`, `time`, `description` and `attributes`.                                        |
| `statements` | `id`, `type`, `content`    | Facts, rules, goals, quests or notes. Can have `subjectIds` and `attributes`.                                     |

A source runs plugin projections only when it explicitly sets `effects: [projections]`:

```yaml
sources:
  worldIr:
    kind: yaml
    path: data/world.ir.yaml
    schema: contract:world-ir@1
    to: world:metadata.worldIr
    effects:
      - projections
```

On import, Covel finds the `contributes.worldProjections` of the plugins that this game has finally enabled. It sorts them by `pluginId/projectionId`, and runs only those whose `from` is exactly the same as the source's schema. The handler receives:

```ts
{
  value: WorldIRV1;
  context: {
    sessionId: string;
    worldId: string;
    sourceId: string;
    locale?: string;
    now: string;
  };
}
```

What the handler returns:

- It must be an object. Its keys are the declared output IDs. The value of each output can be one record or an array of records.
- An extra output, a missing key field, a handler path outside the allowed area, or a result that does not match the target's `contributes.data` JSON Schema is rejected.
- Each projected record goes through the transaction, the import ledger and `sync-data`, the same as normally imported data. Its source is recorded as `projection:<pluginId>/<projectionId>`.
- When no enabled projection matches, the source writes zero projected records. This is not an error.

Projection of `living-world-rules`: each source statement ID becomes `world-ir-` followed by the hexadecimal UTF-8 SHA-256 digest of that ID. The original ID is kept in `sourceStatementId`. This way, Chinese IDs, IDs with punctuation and very long IDs all meet the target's ID rules. If the source ID changes, the key changes with it. All WorldIR rules use the same mapping. Hand-written rules are not affected.

Execution limits:

- `preflight` checks only the source, the declarations, the target and the schema. **It does not load or run any handler.** Which keys a projection actually produces is known only after an import or a sync.
- Import and sync run only the matching declarations of the plugins enabled in this game. When one projection fails, it only produces a warning. It does not stop the original source from being written, and it does not affect other plugins' projections.
- Each declared output either succeeds as a whole group or is not written at all. If any record has an invalid key or schema, the group keeps the last successful content and ledger, and old and new content are never mixed. Only when the handler successfully returns `[]` does it mean "there really are no records". Only then are the old records deleted.
- A built-in plugin's handler can run directly. A community plugin's handler needs this game to explicitly allow it to run server code. Permission cannot be given before the session is created, so for a community projection, run it afterward like this: after the session is created, call the plugin enable (you can call it again even when the plugin is already enabled). This triggers the session-level permission for `covel:plugin-server-code`. Then call `sync-data`. Without permission, an import only emits a warning and does not run the code in secret.
- Each call runs in its own Worker. Its input is a structured clone:

  | Limit                          | Value                      |
  | ------------------------------ | -------------------------- |
  | Timeout                        | 1 second                   |
  | V8 old / young generation caps | 128 / 32 MiB               |
  | Stack limit                    | 4 MiB                      |
  | JSON output limit              | 1 MiB                      |
  | Records per output             | 1000                       |
  | Projections per source         | The first 32 after sorting |

  Worker isolation is only there to stop state from affecting other work and to stop resource abuse. **It is not a security sandbox.** Code that has been allowed can still reach Node and the network.

- The digest of the handler file, the identity of the projection and output, and the records actually produced are all counted in the source digest in the ledger. If only the handler changes and the world data does not, the next sync can still detect the change. If the digest of the handler is different before and after running, the result is thrown away. This prevents wrong source records from being written during a hot update.
- When a session is created, Covel first reads the source, runs the projections, and builds an unchangeable plan. This happens outside the lock and the database transaction. Then the plan is applied in one transaction. Sync works the same way: a dry run takes no write lock. The actual write takes the lock only briefly, rechecks the world, the language, the enabled plugins and the permission scope, then checks for conflicts and applies the changes.

**Discovery.** Development tools and agents can find out how to write the `projections` effect and the contract URI through `GET /api/framework/capabilities`. They can then read each plugin's combined `worldProjections` through `GET /api/plugins/:id`. These APIs return only declaration information. They do not expose plugin root paths or handler paths, and they cannot call a handler directly.

**Static data and extraction during play** use the same `contract:world-ir@1`, but they run in different ways:

- Static world data uses the handlers described above.
- During play, the `world-ir` agent extracts facts from the narrative output (`narrative-engine@1`) once. Then `codex`, `core-quest/log`, `affinity`, `inventory/ledger` and `npc-graph/extractor` read that one result in parallel.
  - Quests and items are function runtimes that read fixed fields only. They do not call a model.
  - Affinity is still judged by the agent. For its fields, see [tools.md · submit-world-facts](./tools.md#submit-world-facts).
  - `inventory/vocabulary` and `core-quest/vocabulary` announce, in the pre-turn stage through `world-ir.vocabulary@1`, the item names, quest names and open objectives being tracked. The extraction uses the same names.
- When this shared extraction fails, the runtimes that depend on it are skipped. The narrative for the turn can still be committed successfully.
- In a session where dimensions are maintained automatically, a `pending-settlement` is still left behind. A failure or a skip must not be treated as "the dimensions did not change". The next narrative is blocked until recovery is complete.

## World character schema

The `characterSchema` at the top level of `world.yaml` says which types and attributes the characters in this world have:

```yaml
characterSchema:
  types: [npc, companion]
  attributes:
    - id: affection
      name: 好感度 # in world.en-US.yaml, write `name: Affection` under the same id
      type: number
      min: 0
      max: 100
      defaultValue: 0
      category: social
```

- `types` lists the character types other than the player. `player` is a reserved type, so do not write it in `types`. Each game has at most one player character.
- `attributes` are the attributes a character can have.
- When a session is created, the schema is copied into the session. A character's `fields` must match it, and a non-player character's type must be in `types`. Tools, plugin reads and the final save all use the same validation.
- Changing a world's `characterSchema` affects only new sessions. An existing session must be changed explicitly inside the session.

For plugin authors:

- The proposal that changes a session's schema is `character.schema.set`. Its content is `{types, attributes}`, and the kernel increments the version.
- The guard of `world-init` uses the schema the session already has first, then the schema the world declares. It calls the model to generate a schema only when neither exists.
- Dimensions and character attributes are different things. A dimension's structure does not turn into a character attribute automatically. A schema is not copied from another session or from another plugin's private data.

## Domain characters and plugin character cards

Characters come from two kinds of files, which do different jobs:

| File                         | What it is                                                                        | Who reads it                                 |
| ---------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `characters/characters.json` | Domain characters: the character records that actually exist in the session       | The kernel, the character panel, all plugins |
| `characters/main-cast.json`  | Character cards: optional role-play notes for the model (voice, motives, secrets) | The `character-blueprint` plugin             |

All four built-in worlds include both. In a descriptor, write them like this:

```yaml
schemaVersion: 1
sources:
  cast:
    kind: json
    path: characters/main-cast.json
    schema: contract:character.blueprints@1
    to: contract:character.blueprints@1
    key: id
  characters:
    kind: json
    path: characters/characters.json
    to: characters
    key: id
    after: cast
```

An example of a domain character file:

```json
[
  {
    "id": "mio",
    "name": "Mio",
    "aliases": ["Class President", "澪"],
    "type": "npc",
    "description": "A fellow student.",
    "fields": { "affection": 20 }
  }
]
```

**Order.** Domain characters enter the session in the order the author wrote them in the file. The panel and the roster in the prompt both use this order. When several sources write characters, they follow on in the order the sources are imported. Characters created during play come after them. (In the implementation, each character's `createdAt` is one millisecond later than the one before it on import, and the list is sorted by `(createdAt, id)`.)

**Aliases (`aliases`).** Optional. Write the other names the story uses for the same person: a nickname, a title that refers only to this one person, or a name in another writing system. Write them in the form and order you want shown.

- The model that tracks characters, relations and affinity finds people by name. When you write an alias, and the model uses the alias, it finds this character instead of creating a new one.
- One name can belong to only one character. When an alias is the same as another character's name or alias, `pnpm validate:world` reports an error on the later record, and the session is not created with that data. Case, full-width and half-width characters, spaces and middle dots do not count as differences.
- Do not write common nouns that could refer to other people, such as "scholar" or "landlady", as aliases.
- In a language file, the `aliases` list replaces the list in the main file as a whole.
- For the full rules, see [aliases and name resolution](./world-model.md#aliases-and-name-resolution).

**ID.** On import, the ID in the file (such as `mio`) is used exactly as written, with no prefix. Character records are not copied into any plugin's data. The panel and plugins read the same data through `ctx.world.characters` or the character API. Turning off the plugin that receives character cards only skips the cards. It does not affect domain characters.

**`effects: [characters]`.** This can turn the general `{id,name,type,description,fields}` of a source into domain characters. It does not understand the `persona/attributes/instantiate` of character cards. It is better to write a separate source with `to: characters` that states clearly which fields go into the session.

**Where the fields of a character card go.** This assumes the receiving plugin `character-blueprint` is enabled in this game:

| Character card field                                                                                        | Where it goes                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `persona.summary`, `description`, `role`, `aliases`, `tags`, `attributes`                           | The plugin's read-only "preset characters" panel                                                                                                                                                          |
| `persona` (`voice`, `style`, `summary`, `traits`, `goals`, `fears`, `secrets`), `rules`, `dialogueExamples` | The `<character-notes>` section of the story runtime's prompt. The character is played using these notes. `secrets` is marked as known only to the narrator.                                              |
| `scenarioDefaults.relationships`, `scenarioDefaults.state`                                                  | The same prompt section. `state` is listed only as opening facts. It is not saved, and tools cannot change it.                                                                                            |
| `attributes`, `instantiate`                                                                                 | Not turned into domain characters automatically. Domain characters come from the source with `to: characters`. These are used only when the `import` runtime is run by hand and instantiates a character. |

Three points to note:

- The prompt section holds only the cards of characters "in this game". To tell, check whether the card's `id` equals a domain character's `id`, or whether the domain character's `id` is `npc-<card id>`. So character cards and domain characters must use IDs that match.
- A state the model should be able to change must be declared as an attribute of `characterSchema`, and written into the domain character's `fields`. A switch written only in `scenarioDefaults.state` has no way to be changed.
- By default, AI world creation in the app generates only domain characters, and puts their voice and motives in `description`. Character cards are generated separately, as in the table above, only when the creator ticks the "preset characters" content that the receiving plugin provides.

For the length limits and the trimming order, see the [plugin README](../../../plugins/character-blueprint/README.md#角色卡怎样进入叙事).

## Character presence portraits

Give characters avatars and portraits, which are shown in the `character-blueprint` portrait panel and in dialogue. For the full image production process, see [character portraits](../worlds/portraits.md). This section covers the data format.

A world package delivers two things: a directory of images, and a mapping file that says which image each character uses. When they are at the convention paths (`media/portraits/` and `media/presence.json`), you do not need a descriptor. In a descriptor, they are two sources:

```yaml
sources:
  portraits:
    kind: media
    path: media/portraits # one directory level, holds <id>.webp
    to: media
    indexTo: contract:character.portrait-assets@1
    key: filename
    after: cast
  presence:
    kind: json
    path: media/presence.json
    schema: contract:character.portraits@1
    to: contract:character.portraits@1
    key: characterId
    after: portraits
```

- The first source imports the images under `media/portraits/` into the media library, and gives the index to `character-blueprint`. Each image uses the SHA-256 of its content as its identifier.
- The second source, `presence.json`, is an array. Each item points the `avatar` / `sprite` of the character named by `characterId` to one image.
- Write `characterId` as the original `id` from `characters/characters.json` (such as `npc-kamishiro-mio`). After import, the character's ID is the same. When the front end matches, a character ID that is exactly the same, or that ends with `-<characterId>`, counts as a match.

```json
[
  {
    "schemaVersion": 1,
    "characterId": "npc-kamishiro-mio",
    "displayName": "神代澪",
    "avatar": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/webp",
      "size": 2155557
    },
    "sprite": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/webp",
      "size": 2155557
    },
    "visuals": {
      "defaultVariant": "uniform-neutral",
      "variants": [
        {
          "id": "uniform-neutral",
          "outfit": "uniform",
          "expression": "neutral",
          "pose": "default",
          "sprite": {
            "id": "0000000000000000000000000000000000000000000000000000000000000000",
            "mime": "image/webp",
            "size": 2155557
          },
          "stage": { "scale": 1, "offsetX": 0, "offsetY": 0 }
        }
      ]
    }
  }
]
```

> [!IMPORTANT]
> The `id` in an image reference must be the **64-character lowercase SHA-256** of that image's content. It must equal the identifier in the media library, or the image cannot be found. Do not calculate it by hand. Run `scripts/emit-presence.mjs <world>`, which generates `presence.json` automatically from `media/portraits/`. **After you regenerate the portraits, you must run it again** to refresh the hashes.

**Variants (`visuals`).** Optional. Use them to give one character several outfits and expressions. `avatar` / `sprite` are the base images.

- Each variant must have a unique `id` and a `sprite`. You can label it with `outfit`, `expression` and `pose`.
- `stage.scale` (0.5–2), `offsetX` and `offsetY` (-100 to 100, as percentages) correct the size and baseline on screen of source images that are cropped differently.
- The stage looks for an image in this order: the exact variant id, then the combination of outfit, expression and pose, then the default variant, then the base sprite or avatar. So when the story asks for an expression that has not been drawn yet, the character still appears, and the screen is not blank.
- `scripts/emit-presence.mjs` gives each character a `default/default/neutral/default` variant by default. The author can keep adding outfit and expression images to the generated result.

**Limits and enabling:**

- A single media file can be at most 20 MB. The total of one source's directory can be at most 100 MB.
- The extensions that can be imported are `.png`, `.jpg`, `.jpeg`, `.webp`, `.mp3`, `.wav` and `.mp4`.
- The preflight check requires that the schema of the matching contract and the receiving declaration are registered. The `assets` and `presence` of `character-blueprint` receive `character.portrait-assets@1` and `character.portraits@1` respectively.
- Put the receiving plugin in `pluginPolicy.recommended`, and the player can choose it. When it is not enabled, its data and media index are skipped, and a warning is given.

For real examples, see `worlds/mistport` and `worlds/haruka-academy` (`data/world.data.yaml` + `media/`).

## Scene backgrounds

A scene background is an illustration of a place (a classroom, a club building, a sea wall), with one picture for day and one for night. For the full process, see [scene backgrounds](../worlds/scenes.md). This section covers the data format.

- Backgrounds that come with a world package are imported through `stage.scene-assets@1` / `stage.scenes@1`, and the `scene-stage` plugin receives them. Using existing images does not require any image model to be set up.
- The image role that the plugin's `modelPresetId` points to is called only when `scene-stage`'s automatic image filling is turned on and an image is missing. Installing a community illustration plugin does not choose a model for it. See [image generation](./image-generation.md).

It uses the same image process as portraits, but with a different manifest. The author writes `media/scenes.json` by hand. A script generates WebP files from the manifest in batch. Then `scripts/emit-scenes.mjs` generates `scenes.registry.json`.

Fields of `media/scenes.json`:

| Field          | Description                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | The scene's ID, and also the file name prefix (`<id>-day.webp` / `<id>-night.webp`).                                                                                                                                                                                                                                                                            |
| `name`         | The display name of the scene.                                                                                                                                                                                                                                                                                                                                  |
| `locationRef`  | The place name the author defined. When one background covers several places, separate them with `/` (`图书馆/二楼窗边长桌/旧刊架`). Each part is one name for this scene. The built-in geography template's declaration path is `geography.initialValue.regions[].name` or `landmarks[].name` in it. This is not a dimension structure the framework requires. |
| `subject`      | The English description of the picture (daytime). The final image prompt is `style.prefix + subject + style.suffix`.                                                                                                                                                                                                                                            |
| `subjectNight` | Optional. A description used only for the night picture. If left empty, the night picture uses `subject` (together with `style.nightSuffix`).                                                                                                                                                                                                                   |

**How a location in the narrative report matches a scene.** Before comparing, spaces are removed and case is ignored. Use the rules below in order. Look at the next rule only when the previous one gives no result:

1. The location equals the scene's `name`, or one part of its `locationRef`.
2. The location contains one of the names (the location "图书馆二楼" matches the name "图书馆"). When several names match, the longest one is used.
3. One of the names contains the location (the location "海堤" matches the name "樱坂海堤"), and only one scene does this. When two scenes' names both contain the location, nothing matches, and the stage does not change its background picture.

So write names in the words the narrative will use, and avoid letting two scenes share the same short fragment.

**Both sources are required.** One imports the pictures into the media library, and one imports the registry. A media source must have `key` and `indexTo`. Otherwise the pictures are not imported (see the [media source](#descriptor) note above):

```yaml
sources:
  scenes:
    kind: media
    path: media/scenes
    to: media
    indexTo: contract:stage.scene-assets@1
    key: filename
    after: dimensions
  scenesRegistry:
    kind: json
    path: media/scenes.registry.json
    schema: contract:stage.scenes@1
    to: contract:stage.scenes@1
    key: registryId
    after: dimensions
```

For a working example, see `worlds/haruka-academy/data/world.data.yaml`.

**`scenes.registry.json`** is generated automatically by `scripts/emit-scenes.mjs`. Do not write it by hand. After you regenerate the scene pictures, you must run the script again to refresh the hashes.

- Its shape is `{schemaVersion, registryId, scenes:[{sceneId,name,locationRef?,day,night}]}`. `day` and `night` are image references identified by SHA-256.
- The whole file is imported as **one** record. `registryId: "scene-registry"` is a fixed value, and it also serves as the `key`. A plugin reads this one record and gets all the scenes.

The only difference from portraits: a portrait needs only the index of each image. A scene picture needs the index, and also has to hand the whole registry to `scene-stage`.

> [!TIP]
> **When there are no pictures yet.** If `media/scenes.registry.json` does not exist, world data validation fails, because the source refers to a file that is not there. Run `emit-scenes.mjs` once on an empty `media/scenes/` directory. It produces a valid empty registry (`{schemaVersion: 1, registryId: "scene-registry", scenes: []}`). Put it in the world package as a placeholder first. When `scenes` is empty, the stage shows the world's header picture. This is not an error. After you generate the pictures, run `emit-scenes.mjs` again to overwrite the file. You do not need to change `world.data.yaml`.

## Background music

A world package's background music is received by the `soundtrack` plugin (contracts `stage.music-assets@1` / `stage.music-tracks@1`). Playing the music does not need any model. The plugin picks a track from the track list, based on the current scene and mood, and the app plays it (see [ui-panels.md](./ui-panels.md#stage-music)).

A world package provides two things:

- Music files under `media/music/`: `.mp3` / `.wav`. A single file can be at most 20 MB, and the whole directory at most 100 MB.
- A hand-written track list, `media/music.yaml`.

Tracks (each item in `tracks`):

| Field    | Description                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | The track's ID. It must be unique in the list.                                                                                                                                                |
| `title`  | Optional. The track name shown to the player when it plays.                                                                                                                                   |
| `file`   | The file name under `media/music/`. Do not write a hash. On import, each file gets one index record, keyed by the file name.                                                                  |
| `theme`  | Optional. `true` makes it the world's theme. It plays when no other track fits.                                                                                                               |
| `scenes` | Optional. A list of scene names used in the narrative. When declared, the track plays only in these scenes. A scene name matches when the names are the same, or when one contains the other. |
| `moods`  | Optional. The moods this track suits. The world author names them (see below). Case is not significant.                                                                                       |
| `loop`   | Optional. `false` means it plays once. The default is to loop.                                                                                                                                |
| `volume` | Optional. The volume of this track (0–1). The default is 1. The player's own volume is multiplied on top of it.                                                                               |

**Moods.** There is no fixed list of moods. The top level of the track list can have `moods`, which lists this world's music moods and when each one applies. The narrative sees only the names and descriptions here. When the story's mood becomes one of them, it sends a `music.cue`:

```yaml
moods:
  - id: battle
    when: 刀已出鞘，胜负未分。
  - id: 灯下
    when: 回到有灯有火的地方，暂时安全。
```

- When the top-level `moods` is not written, the mood list is the set of names that appear in each track's `moods`.
- In a world where no track has `moods`, the narrative is not given a mood list. The music only follows the scene and the theme. Other plugins can decide how to switch later.
- `silence` is a reserved word. It means stop the music.

**Track order.** The order of `tracks` is the order of priority. The plugin looks in this order:

1. A track that fits the current mood and belongs to the current scene.
2. A track that fits the current mood, with no scene limit.
3. The current scene's own track.
4. The theme.
5. Silence.

The mood comes from the `music.cue` event that the narrative sends. The scene comes from the `scene.set` event (sent by the plugin that tracks the scene). If you want only one theme that runs through the whole game, put one track with `theme: true` in the list. It does not depend on any event.

> [!NOTE]
> Put `soundtrack` in the world's `pluginPolicy`. These data are imported and played only after the player turns the plugin on.

**How to declare it.** A world without a descriptor just needs its files at the two convention paths above. A world with a descriptor writes two sources. `registryId: music-registry` is a fixed value in the track list, and it also serves as the `key`:

```yaml
sources:
  music:
    kind: media
    path: media/music
    to: media
    indexTo: contract:stage.music-assets@1
    key: filename
  musicTracks:
    kind: yaml
    path: media/music.yaml
    to: contract:stage.music-tracks@1
    key: registryId
    after: music
```

**The cover, the theme color and the music on the world list** are also written in `world.yaml`. All three can be left out:

| Field         | How to write it                                                                                                                                           | Where it is used                                                                                            | When left out                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `cover`       | The path of one picture: a `.png` / `.jpg` / `.webp` in a directory one level under `media/`, at most 20 MB, for example `media/gallery/world-cover.webp` | The world card, the world detail page, the session-prep screen and the session background                   | The interface uses its built-in default background |
| `accentColor` | `#rrggbb` or `oklch(72% 0.12 75)`                                                                                                                         | The accent color of cards and titles                                                                        | A fixed hue is calculated from the world ID        |
| `themeMusic`  | The path of one audio file: a `.mp3` / `.wav` in a directory one level under `media/`, for example `media/music/theme.mp3`                                | Plays on the world selection page and the world detail page while that world is shown. No plugin is needed. | Does not play                                      |

- The cover does not have to be listed in `media/gallery.json`. If it is listed, the world detail gallery does not show it a second time.
- `themeMusic` is usually the same file as the one marked `theme: true` in the track list.
- `pnpm validate:world` checks that the cover can be shown (`cover`) and that the music can be played (`theme-music`). A wrong color format is reported by the schema.
- AI-generated worlds have no pictures, so they have no `cover` and no `accentColor`.

## Third-party extensions

This section covers two things: how a plugin author lets a world package carry data for that plugin, and how to add data to a world that already exists.

Third-party content can be delivered in two ways: as a standalone world package, or as an override package. The plugin author should publish a versioned contract (`contract:<contractId>`), and the world package refers to it.

A standalone world package:

```text
worlds/my-world-extra/
├── world.yaml
└── data/
    ├── world.data.yaml
    ├── characters/cast.json
    └── dimensions.yaml
```

Adding a local override to an existing world:

```text
~/.covel/world-overrides/<world-id>/
├── world.data.override.yaml
└── data/
    └── characters/cast-extra.json
```

`world.data.override.yaml`:

```yaml
schemaVersion: 1
sources:
  cast-extra:
    kind: json
    path: data/characters/cast-extra.json
    schema: contract:character.blueprints@1
    to: contract:character.blueprints@1
    key: id
    after: cast
```

In an override, `path` is relative to `~/.covel/world-overrides/<world-id>/`. After symbolic links are resolved, the path must still be inside this directory.

### Companion plugin data

To see what the current version can preset, how each item is declared, and how to write it, run the command below. The output comes from each plugin's `contributes.data.*.authoring` declaration. It includes source entries you can paste directly and a valid example:

```bash
pnpm describe:authoring              # text
pnpm describe:authoring --json       # machine-readable
pnpm describe:authoring --plugins ~/.covel/plugins   # also scan community plugins
```

**How a plugin receives world data.** Publish both the schema and the receiving declaration in the root `PLUGIN.md`:

```yaml
id: social-sim
kind: plugin
description: Import relationship records.
contracts:
  social.relationships@1:
    schema: ./schemas/relationships.schema.json
contributes:
  data:
    relationships:
      version: 1
      accepts: [social.relationships@1]
      schema: ./schemas/relationships.schema.json
```

- The schema is a JSON Schema file in the plugin's root folder.
- The receiving declaration is written only in the package's root `PLUGIN.md`. It is not written in `RUNTIME.md`.
- Plugin code reads its own data with `ctx.pluginData.get(namespace,key)` / `list(namespace)`. RPC uses `ctx.store`, which is bound to the current session and plugin. Do not read another plugin's private data.

A plugin author must also do three things:

1. Write the namespace, the contract, the data shape and an example file clearly in `PLUGIN.md`.
2. Read its own data in a runtime or a tool.
3. Give world authors a minimal, working `data/world.data.yaml` fragment, and declare `authoring.source`, so the file can be read from a convention path.

**The world package side.** It is best to use an array for data files, with one object per record:

```yaml
- id: mio-rin
  from: kamishiro-mio
  to: asakura-rin
  type: clubmate
  score: 42
```

The matching source:

```yaml
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: contract:social.relationships@1
    to: contract:social.relationships@1
    key: id
    after:
      - cast
```

**Import ledger.** When a session is created, each record that is actually written (plugin data, lorebook, characters and media index) is recorded in `world_data_import_ledger`. The ledger holds `target`, `pluginId`, `namespace`, `key`, `sourceDigest`, `valueHash`, `schemaRef` and `sourceId`. The session, plugin data, lorebook, characters and ledger are written in the same transaction. If the import fails, everything is rolled back. Later [sync](#preflight-and-sync) uses this ledger to tell which records came from the world package, and whether they have been changed.

#### Built-in RPG seed data (quests / items / affinity)

Three built-in RPG plugins accept data preset by a world package. For a step-by-step guide, see [starting content](../recipes/starting-content.md). For a finished example, see `worlds/emberback/data/`.

| Plugin       | Schema URI                      | to                              | Record shape                                                                                                                        |
| ------------ | ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `core-quest` | `contract:quests@1`             | `contract:quests@1`             | `{ id, name, description, status?, objectives?: [{id?, text, done?}], giver?, reward? }`                                            |
| `inventory`  | `contract:inventory.items@1`    | `contract:inventory.items@1`    | `{ id, name, quantity, description?, tags?: string[], equipped?: boolean }`                                                         |
| `affinity`   | `contract:character.affinity@1` | `contract:character.affinity@1` | `{ id, name, score (int -100..100), notes? }` (derived fields such as tier and history are filled in when a tool first writes them) |

- All three use `key: id`. Their convention paths are `data/quests.yaml`, `data/items.yaml` and `data/affinity.yaml`.
- A preset quest is only advanced by `core-quest`, never rebuilt. It is best to give each quest objective an `id` that is stable within the quest. Later, even if `text` is slightly rewritten, the advance still ticks the same objective.
- Preset items are the starting inventory.
- Preset affinity gives key NPCs a non-zero starting point. It can be positive or negative.

### Preflight and sync

**Preflight (preflight):** looks through what this import would write, and what problems it has, without writing anything.

```http
POST /api/worlds/<world-id>/world-data/preflight
```

- When `plugins` is passed, preflight uses that plugin selection.
- When `sessionId` is passed, preflight uses the plugins enabled in that existing session.
- The built-in interface calls it automatically before the game starts. It shows what will be written, a summary of the targets, and the diagnostics.

**Sync (sync):** applies later changes in the world package to a game that already exists.

```http
POST /api/worlds/<world-id>/sync-data
```

By default this is only a trial run (dry-run). It returns `upserted`, `deleted`, `unchanged` and `conflicts`. Pass `dryRun:false` to actually write.

Sync rules:

1. Only handles records in the import ledger where `managed=true`, and whose `sourceWorldId` is the current world.
2. A record is overwritten or deleted automatically only when its current content is the same as when it was imported (the hash matches the ledger's `valueHash`).
3. When a record has been changed by the player or a plugin, the result is `conflicts.reason = "modified"`.
4. When the world package still has the record, but the record is gone from the session, the result is `conflicts.reason = "missing"`.
5. A record that has been removed from the world package and is also gone from the session is only cleaned up in the ledger. No conflict is reported.
6. An ordinary imported record can be overwritten with `force:true` to clear a `modified` or `missing` conflict. This does not lift the protection on dimension values that have evolved or that are pending settlement.
7. A record with a conflict stays as it is and is listed in `conflicts`. It does not affect the other records. New records that are not in the ledger (sources or portraits added later to the world package) are still written, and unchanged records are still updated or deleted.
8. A character changed by sync keeps its original `createdAt`, so its place in the character list does not change. Characters added to the world package come after the existing characters.

**Extra rules for dimensions:**

- When the author's declaration has not changed, the current progress is kept, and the initial value is not applied again. A new dimension is initialized with its initial value.
- Changing or deleting a dimension that has already evolved, was edited by hand, or still has a turn pending settlement returns a `modified` conflict. Both the value and the declaration are kept.
- The protection for pending settlement does not depend on the import ledger. A dimension that was initialized during play, and so has no ledger record, is protected the same way. When the declaration has not changed, it is not a conflict.
- Only an imported initial value that has not been changed can take the new declaration or be deleted. When the schema changes, old values are not converted automatically.
- Sync checks the hash and version again inside the transaction. Passing preflight does not mean the data can be overwritten without conditions later.
- When a dimension has a conflict, the plan and the conflicts are returned, and this sync is not applied.

`POST /api/worlds/:id/sync-dimensions` syncs only dimensions. It uses the same ledger and the same conflict rules. It does not clean up other data, and it does not rebuild the lorebook. A notice that a file was hot-updated does not change the session's current values by itself.

**Protection of media files.** Image and music bytes are stored by content, and several games share them. So the handling of deletes and failures is conservative:

- When sync deletes a media index record, it removes the current session's reference to that file only after the transaction commits. The file itself is reclaimed by media cleanup (GC) when nothing uses it.
- During the import preparation, the file is written together with a temporary reference that belongs to this import (`world-data-import:<uuid>`). This stops the file from being cleaned up before the import completes.
- When the import completes, the real session first takes ownership of the file and creates its reference. Then the temporary reference is released.
- When preparation, the transaction or session admission fails, only this import's temporary reference is released. Shared files are not forcibly deleted, and the references of existing sessions are not touched.
- When cleanup fails while a new session is being created, the session is deleted inside the same session lock, and its media ownership and references are released.
- When the data has already been committed but the cleanup fails, the temporary reference is kept, so the committed index does not lose its protection. The same applies when a rollback of session creation fails to delete.
- A failure to release a temporary reference is only logged. A process crash, or a failed release, can leave a temporary reference behind. It expires 24 hours after it was created, and `POST /api/media/cleanup` releases it. Until then, cleanup keeps those files (see [Media store](./media-store.md#temporary-references-during-world-data-import)).

### Boundary between a world package and a plugin package

- A **plugin package** holds the execution logic, the interface, the schema documentation and the default examples.
- A **world package** holds the concrete world data and media.

When a third party delivers a plugin and world data together, organize it like this (for publishing them together, see [collections](../ship/collections.md)):

```text
my-covel-pack/
├── plugins/
│   └── social-sim/
│       ├── PLUGIN.md
│       └── handler.js
└── worlds/
    └── haruka-social-extra/
        ├── world.yaml
        ├── WORLD.md
        └── data/
            ├── world.data.yaml
            └── social/links.yaml
```

`world.yaml` expresses the recommended mix through `pluginPolicy`:

```yaml
pluginPolicy:
  recommended: [social-sim]
worldData: data/world.data.yaml
```

### How to publish an override

To add plugin data to a world that already exists, publish an override package. The installer puts the files here:

```text
~/.covel/world-overrides/haruka-academy/
├── world.data.override.yaml
└── data/social/links.yaml
```

An override descriptor can add new sources. It can also override fields such as `path`, `enabled` and `merge` of an existing source:

```yaml
schemaVersion: 1
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: contract:social.relationships@1
    to: contract:social.relationships@1
    key: id
    merge: skipExisting
```

### Static validation (`pnpm validate:world`)

```bash
pnpm validate:world worlds/my-world
pnpm validate:world --strict --plugins ~/.covel/plugins ~/.covel/worlds/my-world
```

Output when it passes:

```text
✓ worlds/emberback/world.yaml
```

- The validator does not create a session, and it does not run plugin code.
- It reuses the world data preflight that runs when a session is created. So data that passes here will not fail later, when a session is created, because of the content of its records.
- Plugins are looked for in the repository's `plugins/` and in each `--plugins <dir>`.
- When a world declares several languages, preflight runs once for each. This is because [language files](#language-files-namelocaleext) make different languages read different text. Every language file next to the main file is checked, not only the declared languages.

**Checks that do not depend on the schema:**

- The character source and `effects: [characters]` check types and attributes against the world's `characterSchema`, and check that after merging there is at most one player character.
- Lorebook records imported directly must have `content`.
- Records imported directly, and `selective` entries produced by the `+lorebook` projection, must both have a non-empty `keys`.
- Error messages include the file, the record number and the key. When an error is found before import, the whole plan is rejected, and the other valid records are not written either.
- An empty source gives a warning.
- When a receiving plugin declares with [`authoring.references`](./plugins.md) that a value is the `id` of a character attribute, the value is checked against the world's `characterSchema`. A missing attribute, a wrong type or a number outside the attribute's range is an `attribute-reference` error. A world without a `characterSchema` is not checked.
- In a record or a character field, a field whose name ends in `At` or is `timestamp`, with an ISO time as its value, is treated as bookkeeping, and the model does not read it. Each such field gives a `model-hidden-field` warning. To let the model see a time of the story, use a different name (`date`, `diedOn`), or do not write it as an ISO time.
- A field of a record whose name is `id` or ends in `Id` / `Ids`, with a UUID as its value, is also treated as bookkeeping. No model reads it, and it gets a `model-hidden-field` warning too. Use an ID a person can read, in lower-case words and hyphens, for example `npc-lin-yao`.
- `dimensionSources` is checked even when there are no conventional data files at all.

**Diagnostics at a glance:**

| Diagnostic code         | Level             | Meaning                                                                                                                                                                                               |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest-invalid`      | error             | `world.yaml` cannot be parsed or does not match the schema                                                                                                                                            |
| `lore-missing`          | error             | A declared language (`defaultLocale` / `supportedLocales`) has no lore file                                                                                                                           |
| `lore-fallback-missing` | warning           | There is no `WORLD.md`, so a session in an undeclared language gets empty lore                                                                                                                        |
| `lore-narrator-only`    | warning           | The [narrator-only marker](#narrator-only-lore-narrator-only) is missing its end, missing its start, nested or written wrong. The lore after it is hidden from the player.                            |
| `unknown-plugin`        | error or warning  | A plugin ID referenced by `pluginPolicy` / `pluginSettings` is not in the scanned directories                                                                                                         |
| `unknown-preset`        | error             | `pluginPolicy.presetId` is neither a built-in pack nor an ID in this world's `packs`                                                                                                                  |
| `unknown-setting`       | warning           | A key in `pluginSettings` is not a setting the plugin declares, so the value is ignored                                                                                                               |
| `invalid-setting`       | error             | A value in `pluginSettings` does not match the type, range or options the setting declares                                                                                                            |
| `unprovided-contract`   | error or warning  | A contract in `pluginPolicy.requires` has no provider                                                                                                                                                 |
| `unresolved-contract`   | error or warning  | A data contract used by a source has no receiving plugin among the scanned plugins                                                                                                                    |
| `world-data`            | same as preflight | The descriptor, source order, file reading, targets, hidden-data rules, and each record checked against its contract schema                                                                           |
| `locale-file-name`      | error             | A language file's name gives only the language (`.en.`) and not the locale the world declares (`.en-US.`). This file is not read.                                                                     |
| `locale-overlay`        | warning           | A translation in a language file has no place to go (the main file has no such key or ID, or it changed a value that is not text). That entry is ignored.                                             |
| `locale-script`         | warning           | A language file for a language other than Chinese, Japanese or Korean still contains CJK characters: untranslated text, or a trigger word copied from the main file.                                  |
| `edition-incomplete`    | warning           | `supportedLocales` declares a language, but that language's version is missing some translations. A session in that language reads the world's original default-language text.                        |
| `inline-locale-map`     | error             | The main file writes text as a multi-language map. The main file should have one language, and the translations go in language files.                                                                 |
| `data-file-unused`      | warning           | A file in `data/`, `characters/` or `media/` is not used by any source or framework feature                                                                                                           |
| `attribute-reference`   | error             | A value in a record that names a character attribute (declared by the receiving plugin's `authoring.references`) is missing from the world's `characterSchema`, has the wrong type or is out of range |
| `model-hidden-field`    | warning           | A record has a field that no model reads: a name ending in `At` or `timestamp` with an ISO time, or `id` / a name ending in `Id` or `Ids` with a UUID                                                 |
| `cover`                 | error             | The file that `cover` points to cannot be shown by the app                                                                                                                                            |
| `theme-music`           | error             | The file that `themeMusic` points to cannot be played in the world list                                                                                                                               |
| `prompt-size`           | warning           | The content takes up too much of the prompt. See below.                                                                                                                                               |

For the three items marked "error or warning": a spelling close to a known ID is an error, and it suggests "Did you mean". Otherwise the default is a warning, because the provider may be a community plugin that was not scanned. With `--strict`, all of them are errors. `pnpm release:preflight` uses `--strict` for the built-in worlds.

**The three cases of `prompt-size`.** None of them stops the world from being used:

| Content                                            | Warning line | Note                                                                                               |
| -------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `WORLD.md`                                         | 8,000 tokens | This is how much the story prompt can hold. Longer lore is cut after the last full line that fits. |
| Combined `constant` lorebook entries in one source | 2,000 tokens | This content enters the prompt on every turn                                                       |
| Dimension initial values                           | 8,000 tokens | The summary of dimensions in the prompt                                                            |

Length is estimated in tokens: one token per Chinese, Japanese or Korean character, and one token per four other characters. So the same world is measured the same way, whatever language it is written in. Keep the essential setting in `WORLD.md`. Write setting that is needed only in certain situations as `selective` lorebook entries.

The validation logic is in `apps/server/src/world-data/validate-world-package.ts`. It returns structured diagnostics, which other tools can reuse.

### Developer checklist

- Give each source a short name, such as `cast`, `social-links` or `portraits`.
- Put `path` under `data/`, `characters/` or `media/`.
- `schema` refers to a versioned contract, or to a JSON Schema file in the world package.
- `to` uses a public data contract or a kernel target (`characters`, `lorebook` and so on). Which plugin and which namespace the data goes to is decided by the plugin's receiving declaration. The world package does not write it.
- `key` points to a stable ID field in each data object.
- Use markdown / text sources for large blocks of text, yaml / json sources for large amounts of structured data, and media sources for images and audio.
- The paths of a world package and of an override package must both stay inside their own root folders.

## Current limits

- A source reads only local files. The types are `yaml`, `json`, `markdown`, `text` and `media`.
- A media source scans only one directory level. It accepts only fixed extensions (`.png`, `.jpg`, `.jpeg`, `.webp`, `.mp3`, `.wav`, `.mp4`). A single file can be at most 20 MB, and one directory at most 100 MB in total.
- `merge` supports only `replace` and `skipExisting`.
- `key` supports only a simple field name, a fixed key for markdown / text, and `filename` for media.
- Remote sources, SQLite sources, CUE, RO-Crate and complex JSON Patch overrides are not supported at present.

Related pages:

- **World time** is not part of dimensions. It is plugin data. Its contract is `world.time-definition@1`, the record is written as `{ id: world, definition }`, and it is placed in `data/time.yaml`. AI-generated records of this kind keep the same contract in files, in server storage and in browser-local worlds. A world without a folder requires the record's `key` to equal `value.id`. For fields, backward time and random rules, see [World time](./world-time.md).
- For the world package directory on GitHub, choosing several worlds at once, proxy downloads and the update process, see [world catalog and installation](./world-installation.md).
