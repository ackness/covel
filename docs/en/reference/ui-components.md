# UI components

This page lists every component plugin UI can use: what each one is called, what it does, and its main properties. Plugin authors who write `ui/*.json` look up names and properties here.

A plugin's UI is a JSON document (a UI spec), and it can only be built from the components listed here. For how panels and message blocks are discovered, connected to data, and drawn, see [frontend panel architecture](./ui-panels.md).

## Authoring tip

- **Where the components come from.** `apps/web/src/lib/catalog.tsx` exports `covelRegistry`. Each renderer lives under `apps/web/src/lib/catalog/`, grouped by responsibility. A plugin can only use components registered here. The framework sets the vocabulary, and plugins combine it.
- **Referencing them in a plugin.** In `ui/*.json`, write `"component": "<Name>"`, with the name exactly as below. Spec files are discovered through `contributes.ui.right` / `ui.message` / `ui.left` in `PLUGIN.md`.
- **Text and validation.** Write the spec in English, and put translations in the `messages` section of `locales/<locale>.yaml` (see [ui-panels.md](./ui-panels.md#plugin-ui-text-rules)). Run `pnpm check:i18n`. It includes `check-plugin-i18n`, which rejects Chinese in a spec, and requires every interface text of a built-in plugin to have a Chinese translation.
- **Finding components this page does not cover yet.** The full list can be searched at any time:

  ```bash
  rg ": ComponentRenderer = |export function createFilterContainer" apps/web/src/lib/catalog.tsx apps/web/src/lib/catalog
  rg "^  [A-Z][a-zA-Z]+," apps/web/src/lib/catalog.tsx   # registry entries
  ```

  If the code has a component that this page does not, add it. The files in the workspace are the source of truth.

## Data bindings cheat sheet

| Need                                             | How to write it                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Read state                                       | `{ "$state": "/path" }`                                                                                                                 |
| Read and write state (two-way binding)           | `{ "$bindState": "/path" }`                                                                                                             |
| Iterate over an array                            | `repeat: { "statePath": "/path", "key": "id" }`                                                                                         |
| Iterate over a sub-array inside the current item | `repeat: { "statePath": { "$item": "items" }, "key": "id" }`                                                                            |
| Read a field of the current item                 | `{ "$item": "field" }`                                                                                                                  |
| Read and write a field of the current item       | `{ "$bindItem": "field" }`                                                                                                              |
| Current index                                    | `{ "$index": true }`                                                                                                                    |
| Named sub-areas                                  | `slots: { "header": [{ "component": "Text" }], "content": [{ "component": "Stack" }] }`                                                 |
| Transform a value                                | `$format`, `$math`, `$concat`, `$count`, `$truncate`, `$pluralize`, or `$join` (also available in action parameters)                    |
| Multilingual text                                | Write English in properties such as `content` / `label` / `placeholder` / `title` / `message`, and translate in `locales/<locale>.yaml` |

## Components

Properties marked _(I18nText)_ in the tables are text shown to the player, and they are translated by language.

### Layout

| Component   | Use                             | Main properties                             |
| ----------- | ------------------------------- | ------------------------------------------- |
| `Stack`     | Lays out children vertically.   | `gap` (a string, used directly as a style)  |
| `Row`       | Lays out children horizontally. | `gap`, `align` (`center` / `start` / `end`) |
| `Grid`      | A CSS grid.                     | `cols` (a number)                           |
| `Separator` | A horizontal divider line.      | —                                           |

### Display

| Component         | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Main properties                                                                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Text`            | A piece of text, with adjustable style.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `content` _(I18nText)_, `variant` (`muted`), `weight` (`bold`), `size` (`xs` / `sm` / `lg`), `align` (`center`)                                                                                                                                                                                           |
| `Badge`           | A small colored label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `label` _(I18nText)_, `color` (`red` / `amber` / `blue` / `green` / `purple` / `cyan`)                                                                                                                                                                                                                    |
| `Icon`            | Shows a Lucide icon by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `name` (kebab-case, for example `book-open`), `size` (`xs` / `sm` / `md` / `lg`)                                                                                                                                                                                                                          |
| `TagList`         | A row of string tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `tags` (string[])                                                                                                                                                                                                                                                                                         |
| `Prose`           | A narrative paragraph. Supports `**bold**`, and splits paragraphs at two line breaks.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `content` (string)                                                                                                                                                                                                                                                                                        |
| `Source`          | A small label for a source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `label` (string)                                                                                                                                                                                                                                                                                          |
| `Image`           | Shows an image. The image is given by a MediaRef and resolved through the media library. With no ref bound, it shows a placeholder block. With `zoom: true`, clicking enlarges it (using the shared `MediaPreviewDialog`). With `framed: true`, it goes into a rounded card with a border (highlighted on hover), matching the thumbnails of the image gallery.                                                                                                                                                                                | `ref` _(MediaRef, recommended)_, `src` _(the form used in early specs, also accepts a MediaRef)_, `alt` (string), `aspectRatio` (a CSS ratio, default `"1/1"`), `rounded` (`none` / `sm` / `md` / `lg`), `fit` (`cover` / `contain`), `zoom` (boolean, click to enlarge), `framed` (boolean, card border) |
| `Media`           | Shows an image, audio, video, or file. The asset is given by a MediaRef and resolved through the media library.                                                                                                                                                                                                                                                                                                                                                                                                                                | `ref` _(MediaRef, recommended)_, `src` _(the form used in early specs, also accepts a MediaRef)_, `as` (`auto` / `image` / `audio` / `video`), `alt`, `aspectRatio`, `rounded`, `fit`                                                                                                                     |
| `AudioPlayer`     | An audio player that follows the theme and draws itself. It does not use the browser's native `<audio controls>` look. It is a flat playback bar, with colors and corner radius taken from `--color-primary` / `--color-muted` / `--color-border` / `--radius-card`. It has play / pause, a draggable progress bar (mouse and keyboard), `M:SS / M:SS` time, playback speed selection (0.75× / 1× / 1.25× / 1.5× / 2×), and a download button. When the ref is missing or fails to resolve, it shows an "audio unavailable" placeholder block. | `ref` _(MediaRef)_, `src` _(also accepts a MediaRef)_, `alt` (string, also the base of the default download file name), `downloadName` (overrides the file name), `className`                                                                                                                             |
| `MediaGallery`    | A declarative media list: preview, download, and optional regenerate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `items`, `idField`, `refField`, and optional `titleField`, `statusField`, `durationField`, `errorField`, `fields`, `rerunAction`                                                                                                                                                                          |
| `JobList`         | A declarative job list: expandable details, copy, status / error, and optional rerun.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `items`, and optional `idField`, `statusField`, `messageField`, `errorField`, `durationField`, `fields`, `rerunAction`                                                                                                                                                                                    |
| `PortraitGallery` | Character images from `character.visual@1`. Can be previewed, with optional upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Optional `replaceAction`                                                                                                                                                                                                                                                                                  |
| `CandidateList`   | Shows several versions of one piece of text as options. Choosing one runs `acceptAction`. Saving its text as a draft or sending it directly are secondary actions below the options. An optional "Regenerate" action can be added.                                                                                                                                                                                                                                                                                                             | `candidates`, and optional `idField`, `contentField`, `acceptedId`, `turnId`, `hiddenWhen`, `detailFields`, `acceptAction`, `regenerateAction`, plus the labels of each                                                                                                                                   |

**Order during `PortraitGallery` upload.** It first restores the session's workspace, then uploads the replacement media, and then calls the declared runtime through the shared plugin authorization flow. When authorization is retried, it reuses the media references already uploaded. A runtime failure is always shown to the player, including the case where HTTP succeeded but the result reports a failure.

**Icons you can use.** The icons in `Icon.name` and in plugin panels must come from one fixed list. This keeps plugins from pulling the whole Lucide icon library into the client bundle. The current names are:

`anchor`, `backpack`, `book-marked`, `book-open`, `book-user`, `brain`, `calendar-days`, `check-circle-2`, `compass`, `dices`, `gem`, `handshake`, `headphones`, `heart`, `id-card`, `image`, `loader`, `map`, `map-pin`, `megaphone`, `mic`, `network`, `scroll-text`, `search`, `shield`, `skull`, `sliders-horizontal`, `sparkles`, `swords`, `turtle`, `user`, `user-search`, `users`, `users-round`, `wand`, `waves`, `x-circle`.

PascalCase forms such as `BookOpen` are normalized to the same name. An unknown name shows no icon (panel tabs fall back to `HelpCircle`).

### Data

| Component             | Use                                                                                                                                                                                             | Main properties                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card`                | A bordered container.                                                                                                                                                                           | `variant` (`glow` / `subtle`)                                                                                                                                                                             |
| `CardList`            | Lays out `Card` children vertically.                                                                                                                                                            | —                                                                                                                                                                                                         |
| `EntryCard`           | A codex entry card, with a category icon and an accent color for rarity.                                                                                                                        | `title` _(I18nText)_, `category` (string), `content` _(I18nText)_, `tags` (string[]), `rarity` (`legendary` / `rare` / `uncommon` / `common`), `icon`, `color`, `collapsible`, `defaultExpanded`, `isNew` |
| `StatBar`             | A label with a numeric bar showing `value/max`.                                                                                                                                                 | `label` _(I18nText)_, `value` (number), `max` (number)                                                                                                                                                    |
| `Progress`            | A progress bar in percentage style.                                                                                                                                                             | `label` _(I18nText)_, `value` (number), `max` (number)                                                                                                                                                    |
| `Accordion`           | The vertical outer container for `Section` children.                                                                                                                                            | —                                                                                                                                                                                                         |
| `Section`             | A title that can be collapsed, plus its body.                                                                                                                                                   | `title` _(I18nText)_, `icon`, `defaultOpen` (boolean)                                                                                                                                                     |
| `JsonView`            | Shows any JSON value by its shape: basic types are shown directly, arrays are shown as a list of tags, and objects are shown as key: value.                                                     | `value` (any)                                                                                                                                                                                             |
| `EntryList`           | A declarative entry list: title, description, badges, and fields with labels.                                                                                                                   | `items`, `titleField`, and optional `idField`, `descriptionFields`, `badgeFields`, `fields`, `dateField`, `footerField`                                                                                   |
| `SceneCastList`       | The characters on stage from `stage.cast@1`: name, type, and description.                                                                                                                       | None                                                                                                                                                                                                      |
| `CharacterFieldsView` | Shows a character's `fields` object according to the schema. It reads the `characterSchema` of the session's World Model, and groups fields by category (bio/stats/abilities/equipment/social). | `value` (the character's `fields` object)                                                                                                                                                                 |
| `CharacterAvatar`     | An avatar taken from `character.visual@1` by character ID. Click to enlarge.                                                                                                                    | `characterId`, and optional `size` (default `28`)                                                                                                                                                         |

### Interactive

| Component         | Use                                                                                                                                                                                                                            | Main properties                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`          | A button that can be clicked. An interaction a plugin declares shows a "Selected" feedback on the button.                                                                                                                      | `label` _(I18nText)_, `variant` (`default` / `primary` / `danger` / `ghost`), `size` (`compact` / `md`); `on.click.action` = `draftMessage` / `selectChoice` / …                                                                                                                                  |
| `ChoiceList`      | A set of options for the player to pick from. It numbers the `Choice` items inside it. Whether the numbers show, and how (digits, Chinese numerals, or keycaps), is decided by the current theme.                              | Children: `Choice`                                                                                                                                                                                                                                                                                |
| `Choice`          | One option, drawn as a button. While its draft is queued to send, it shows "Selected". While its runtime call is running, it shows "Busy". In the current turn, pressing number keys 1–9 clicks the nth visible option.        | `title` _(I18nText, required)_, `description` _(I18nText)_, `tag` _(I18nText)_, `tone` (colors the tag: `primary` / `info` / `success` / `warning` / `danger`, or a `Badge` color name); `on.click.action` = `draftMessage` / `selectChoice` / `invokeRuntime` / …                                |
| `Input`           | A single-line text input.                                                                                                                                                                                                      | `label` _(I18nText)_, `placeholder` _(I18nText)_, `value` (bound with `$bindState`)                                                                                                                                                                                                               |
| `Textarea`        | A multi-line text input (monospace font, resizable).                                                                                                                                                                           | `label` _(I18nText)_, `placeholder` _(I18nText)_, `rows` (number, default `8`), `value` (bound with `$bindState`)                                                                                                                                                                                 |
| `SearchInput`     | An input box with a search icon.                                                                                                                                                                                               | `placeholder` _(I18nText)_, `value`                                                                                                                                                                                                                                                               |
| `Select`          | A dropdown select.                                                                                                                                                                                                             | `label` _(I18nText)_, `options` (`[{ value, label }]`), `value`                                                                                                                                                                                                                                   |
| `Switch`          | A boolean toggle.                                                                                                                                                                                                              | `label` _(I18nText)_, `checked` (bound with `$bindState`)                                                                                                                                                                                                                                         |
| `FilterBar`       | A horizontal group of toggles (pick one).                                                                                                                                                                                      | `options` (`[{ value, label, icon? }]`), `value`                                                                                                                                                                                                                                                  |
| `Tabs`            | A tab strip. Binds the current value with `$bindState`. The optional `counts` adds `(N)` after a label.                                                                                                                        | `tabs` (`[{ value, label, icon?, color? }]`), `value`, `counts` (`Record<value, number>`)                                                                                                                                                                                                         |
| `FilterContainer` | A container with its own state: it keeps the search term and the current tab itself, and renders each filtered row with a registered component. The implementation is in `apps/web/src/lib/catalog/interactive-renderers.tsx`. | `items`, `searchPlaceholder`, `searchFields` (path[]), `filterField`, `filterTabs`, `itemComponent` (a component name in the registry), `itemPropMap` (`{ propName: itemPath }`), `itemLiteralProps`, `itemKeyField`, `emptyMessage`, `showCounts`, `footer` (a string or `{ component, props }`) |

Accessibility:

- `Input`, `Textarea`, and `Select` link their localized `label` to a stable, unique control ID. This also holds for controls that appear more than once. Clicking the label focuses the matching control.
- `Switch` uses a native button that does not submit a form, with `role="switch"`. The label is its accessible name. Tab focuses it, and Space or Enter toggles its bound `checked` value.
- Give each control a descriptive label. A placeholder cannot replace a label.
- These controls follow the interaction lock of the panel they are in. The spec does not add a new `disabled` property.

### Form

| Component      | Use                                            | Main properties                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Form`         | A bordered form container.                     | —                                                                                                                                                                                                                                                                   |
| `FormHeader`   | The title bar of a `Form`.                     | See `apps/web/src/lib/catalog/session-renderers.tsx` (properties go straight to the layout of the title bar)                                                                                                                                                        |
| `FormField`    | A typed field with a label.                    | `fieldType` (`text` / `textarea` / `number` / `select` / `checkbox`), `min`, `max`, `step` (number fields), `label` _(I18nText)_, `placeholder` _(I18nText)_, `required` (boolean), `options` (`[{ value, label }]`), `value` (bound with `$bindState`), `disabled` |
| `SubmitButton` | The main submit button, with a disabled state. | `label` _(I18nText)_, `disabled` (boolean); emits `click` with `on.click`                                                                                                                                                                                           |

- A number field binds a number when it has content. A checkbox binds a boolean.
- Browser input limits only improve the interaction. They cannot replace server-side validation.
- A form created with `create-form` keeps the field types and limits it declares when it is submitted. A plugin's validator can check rules that span several fields before the submission is written.

See [form tools](./tools.md#create-form) and [plugin testing](../plugins/testing.md).

### Message

| Component       | Use                                                                                   | Main properties                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PlayerMessage` | A player's chat bubble, aligned to the right (the Paper theme has a different style). | `content` (string)                                                                               |
| `Alert`         | An info / success / warning / error notice.                                           | `level` (`info` / `success` / `warning` / `error`), `title` _(I18nText)_, `message` _(I18nText)_ |

### Visualization

| Component         | Use                                                                                                                                                                                                                                                                                                                                                                    | Main properties                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GraphCanvas`     | A force-directed relationship graph, using `react-force-graph-2d` (loaded on demand, about 60 KB after gzip). It draws the nodes and edges the panel gives it.                                                                                                                                                                                                         | `nodes`, `edges`, `node`, `edge`, `height?`, `emptyText?` |
| `WorldDimensions` | Shows the values and versions of session dimensions according to their schema. When runtime metadata that the host has validated is available, it also offers editing and recovery of pending settlements. It reads the public session snapshot. It does not read the author's initial values, and it does not read plugin namespaces. No bindings need to be written. | —                                           |

**`WorldDimensions`**

- It accepts any ID the author defines, and shows scalars, nested values, arrays, and named record collections according to each one's schema.
- The public entries do not include initial values or maintenance rules.
- Writes go through the manual runtime the host provides, and include `expectedVersion`. For refreshing after a conflict, and for the explicit retry / manual handling / skip options, see [dynamic dimensions panel](./ui-panels.md#dynamic-dimensions-overview-and-corrections).

**`GraphCanvas` data mapping**

- `nodes` and `edges` can be arrays, or objects that map "key → record".
- Required `node` mappings: `idField`, `labelField`, `colors` (by type), and `defaultColor`. `typeField`, `summaryField`, and `labelsField` are optional.
- Required `edge` mappings: `idField`, `sourceField`, and `targetField`. `relationField`, `strengthField`, `factField`, `inactiveField`, `defaultColor`, and `colors` (`positive`, `negative`, `neutral`) are optional.
- Field paths are relative to each record. Edges with missing endpoints are hidden.
- When no strength field is mapped or a record omits its strength, the edge uses `defaultColor`, then `colors.neutral`, then gray `#94a3b8`. Its model width is 1, the canvas minimum width is 2.5, and its layout distance is 110.
- Finite strengths retain their existing behavior: model width is `1 + abs(strength) * 2` and layout distance is `110 + abs(strength) * 30`. With `colors`, strengths ≥ 0.33 use positive, ≤ -0.33 use negative, and others use neutral; without it they use the default color. Non-numeric, NaN, and infinite strengths discard the edge.
- An edge is hidden when its configured inactive field is not `undefined`, including `0`, `false`, and `null`.
- `emptyText` (I18nText) can override the default “No graph data yet.”.
- The panel binds its own namespace to these properties. The component does not pick a plugin or a namespace itself.

**How `GraphCanvas` updates**

- When the data changes only in metadata, it refreshes node summaries and relationship text. The simulation keeps the existing nodes' identity, position, and pinned state.
- A new simulation dataset is published only when the topology changes. If either endpoint of an existing edge ID changes, that also counts as a topology change.
- Selection highlighting: each time the data or the selection changes, directly adjacent nodes are computed once. When drawing nodes, membership is checked in constant time.

### Multimodal

| Component          | Use                                                                                                                                                                    | Main properties                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AssetRender`      | Shows an `AssetGenerateView` proposal. It hands the asset to the matching renderer by `view.modality` (image / audio / generic link).                                  | `view` (`AssetGenerateView`), `sessionId?` (overrides the lookup of the "current session") |
| `AssetTurnSidebar` | Shows every generated asset recorded in a turn (from `state.assetsByTurn`, filled in by the `asset.generated` SSE handler). Shows nothing when the turn has no assets. | `turnId`, `sessionId?`                                                                     |

## Summary

There are 50 components in total. The authoritative list is `covelRegistry`, exported from `apps/web/src/lib/catalog.tsx`. The renderer implementations are under `apps/web/src/lib/catalog/`.

When you add a new component:

1. Add its exact name to `PLUGIN_UI_COMPONENT_NAMES` in `packages/shared/src/types/plugin-ui.ts`, then register its renderer in `covelRegistry`. The registry is type-checked: if you add or miss one mapping, the TypeScript check fails.
2. Add a row in the matching section of this page.
3. If it accepts strings the player can see, pass those strings through `resolveI18n` / `useI18nResolver()`, so the subtree re-renders when the language changes.

## Structured list props and actions

This section explains how list components (`EntryList`, `MediaGallery`, `JobList`, `CandidateList`, and so on) read data, and how their actions write it. The runtime schema is in `packages/shared/src/schemas/catalog.ts`.

**List data.**

- A list accepts an array of records. Apart from `CandidateList`, it also accepts an object that maps "key → record". In that case each record gets an extra `key` field.
- A field selector is a dot-separated path relative to each record. It can include array indexes.
- Each item in `fields` is `{ path, label? }`. `label` supports I18nText.
- A plugin maps the shape of its own stored data in its own UI spec. Components do not read plugin storage.

**`CandidateList`.**

- `candidates` is an array. The default selectors are `id` and `content`.
- `hiddenWhen: { field, equals }` hides the records that match, but they remain within the scope that actions can read.
- `acceptedId` marks the one currently selected.
- "Draft / Send" uses session actions. The optional accept and regenerate actions call the RPCs you provide.

**How to write an action.** A catalog action is `{ pluginId, runtimeId, payload, label? }`.

- `pluginId` must be the ID of the plugin that owns this spec, written directly.
- Values in `payload` are used literally. The only exception is a value that is exactly `{ "from": "path" }`. This selector takes its value from `item` (the current row), `props` (the component's properties), or `upload` (the MediaRef obtained by uploading when a portrait is replaced).

```json
{
  "pluginId": "my-plugin",
  "runtimeId": "my-plugin/save",
  "payload": {
    "id": { "from": "item.id" },
    "ref": { "from": "upload" }
  }
}
```

**How an action runs.**

- An RPC action goes through the shared workspace restore and authorization flow.
- An upload is prepared only after the workspace is restored, and it is reused when authorization is retried.
- The plugin that owns this runtime validates the payload and implements the business rules. For example, it replaces the default portrait while keeping the other variants.
- This is the only contract for now. Plugin-specific component names and cross-plugin avatar bindings no longer exist. Specs under development need to be updated to match what is written here.

`MediaGallery` and `JobList` accept `emptyText` (I18nText) to override “No media yet.” and “No jobs yet.”. The gallery uses MIME to show images, audio, video, or download links; playback controls are outside preview buttons. Gallery and preview downloads choose a MIME-based extension, using `.bin` for unknown formats without converting the contents.

**`JobList.relatedMedia`.** Optional. It links the media records you provide to the job rows:

```ts
{ items, itemField, matchField, refField?, idField?, titleField? }
```

The host compares a job's `itemField` value with each media record's `matchField`. An empty value does not count as a match. This way a job row can show its related preview, and the component does not need to know the prompt field or read a second plugin namespace.
