# UI Component Catalogue

Reference for the json-render components available to plugin UI specs. This page is the catalogue — for how panels and message blocks are discovered, wired, and rendered, see [docs/reference/ui-panels.md](./ui-panels.md).

> Chinese translations welcome.

## Authoring tip

- **Registry location** — `apps/web/src/lib/catalog.tsx` exports `covelRegistry`, with renderers split by responsibility under `apps/web/src/lib/catalog/`. Plugins can only use components registered there; the framework controls the vocabulary, plugins compose from it.
- **Reference from a plugin** — in your `ui/*.json` spec, set `"component": "<Name>"` exactly as it appears below. The spec is discovered via `PLUGIN.md` frontmatter (`ui.right` / `ui.message` / `ui.left`).
- **Validate** — any CJK string inside spec JSON must be wrapped as `I18nText` (see [ui-panels.md §I18nText](./ui-panels.md#插件-ui-文本-i18ntext-规范)). Run `pnpm check:i18n` — it wraps `check-plugin-i18n` and blocks bare Chinese literals.
- **Discover new components added after this doc** — the full list is always grep-able:

  ```bash
  rg ": ComponentRenderer = |export function createFilterContainer" apps/web/src/lib/catalog.tsx apps/web/src/lib/catalog
  rg "^  [A-Z][a-zA-Z]+," apps/web/src/lib/catalog.tsx   # registry entries
  ```

  If a component you see in the code is missing from this page, add it — matching files in the working tree are the source of truth.

## Data bindings cheat sheet

| Need                      | Write                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Read state                | `{ "$state": "/path" }`                                                                                                      |
| Two-way bind state        | `{ "$bindState": "/path" }`                                                                                                  |
| Iterate array             | `repeat: { "statePath": "/path", "key": "id" }`                                                                              |
| Iterate nested item array | `repeat: { "statePath": { "$item": "items" }, "key": "id" }`                                                                 |
| Current item field        | `{ "$item": "field" }`                                                                                                       |
| Two-way bind item field   | `{ "$bindItem": "field" }`                                                                                                   |
| Current index             | `{ "$index": true }`                                                                                                         |
| Named child regions       | `slots: { "header": [{ "component": "Text" }], "content": [{ "component": "Stack" }] }`                                      |
| Transform a value         | `$format`, `$math`, `$concat`, `$count`, `$truncate`, `$pluralize`, or `$join` (also valid in action params)                 |
| Resolve i18n              | pass any `I18nText` value (`{ "zh": "…", "en": "…" }`) to any `content` / `label` / `placeholder` / `title` / `message` prop |

## Components

### Layout

| Component   | Purpose                     | Key props                                   |
| ----------- | --------------------------- | ------------------------------------------- |
| `Stack`     | Vertical stack of children. | `gap` (string; styling pass-through)        |
| `Row`       | Horizontal row of children. | `gap`, `align` (`center` / `start` / `end`) |
| `Grid`      | CSS grid.                   | `cols` (number)                             |
| `Separator` | Horizontal rule.            | —                                           |

### Display

| Component         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                 | Key props                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Text`            | Paragraph text with variant controls.                                                                                                                                                                                                                                                                                                                                                                                                   | `content` _(I18nText)_, `variant` (`muted`), `weight` (`bold`), `size` (`xs` / `sm` / `lg`), `align` (`center`)                                                                                                                                                                    |
| `Badge`           | Small coloured pill.                                                                                                                                                                                                                                                                                                                                                                                                                    | `label` _(I18nText)_, `color` (`red` / `amber` / `blue` / `green` / `purple` / `cyan`)                                                                                                                                                                                             |
| `Icon`            | Lucide icon by name.                                                                                                                                                                                                                                                                                                                                                                                                                    | `name` (kebab-case, e.g. `book-open`), `size` (`xs` / `sm` / `md` / `lg`)                                                                                                                                                                                                          |
| `TagList`         | Flat list of string tags.                                                                                                                                                                                                                                                                                                                                                                                                               | `tags` (string[])                                                                                                                                                                                                                                                                  |
| `Prose`           | Narrative paragraphs with `**bold**` support, split on double newline.                                                                                                                                                                                                                                                                                                                                                                  | `content` (string)                                                                                                                                                                                                                                                                 |
| `Source`          | Small attribution label.                                                                                                                                                                                                                                                                                                                                                                                                                | `label` (string)                                                                                                                                                                                                                                                                   |
| `Image`           | Renders an image from a MediaRef resolved through the media store. Falls back to a placeholder tile when no ref is bound. With `zoom: true` the image becomes click-to-enlarge via the shared `MediaPreviewDialog`; with `framed: true` it sits in a rounded bordered card (hover highlight) matching the image-generation gallery's thumbnails.                                                                                        | `ref` _(MediaRef, preferred)_, `src` _(MediaRef accepted for early specs)_, `alt` (string), `aspectRatio` (CSS ratio, default `"1/1"`), `rounded` (`none` / `sm` / `md` / `lg`), `fit` (`cover` / `contain`), `zoom` (boolean — click to enlarge), `framed` (boolean — card frame) |
| `Media`           | Renders image / audio / video / file assets from a MediaRef resolved through the media store.                                                                                                                                                                                                                                                                                                                                           | `ref` _(MediaRef, preferred)_, `src` _(MediaRef accepted for early specs)_, `as` (`auto` / `image` / `audio` / `video`), `alt`, `aspectRatio`, `rounded`, `fit`                                                                                                                    |
| `AudioPlayer`     | Theme-aware self-drawn audio player. Replaces native `<audio controls>` chrome with a flat playlist row using `--color-primary` / `--color-muted` / `--color-border` / `--radius-card`. Includes play/pause, scrubbable progress bar (pointer + keyboard), `M:SS / M:SS` time, speed selector (0.75× / 1× / 1.25× / 1.5× / 2×), and download button. Falls back to an "audio unavailable" tile when ref is missing or resolution fails. | `ref` _(MediaRef)_, `src` _(MediaRef accepted)_, `alt` (string, also used as default download filename stem), `downloadName` (override filename), `className`                                                                                                                      |
| `MediaGallery`    | Declarative media rows with preview, download, and optional rerun.                                                                                                                                                                                                                                                                                                                                                                      | `items`, `idField`, `refField`, optional `titleField`, `statusField`, `durationField`, `errorField`, `fields`, `rerunAction`                                                                                                                                                       |
| `JobList`         | Declarative job rows with expandable details, copy, status/error and optional rerun.                                                                                                                                                                                                                                                                                                                                                    | `items`, optional `idField`, `statusField`, `messageField`, `errorField`, `durationField`, `fields`, `rerunAction`                                                                                                                                                                 |
| `PortraitGallery` | Character imagery from `character.visual@1`, with preview and optional upload.                                                                                                                                                                                                                                                                                                                                                          | optional `replaceAction`                                                                                                                                                                                                                                                           |
| `CandidateList`   | Candidate text, selection, draft/send, and optional RPC actions.                                                                                                                                                                                                                                                                                                                                                                        | `candidates`, optional `idField`, `contentField`, `acceptedId`, `turnId`, `hiddenWhen`, `detailFields`, `acceptAction`, `regenerateAction`, labels                                                                                                                                 |

`PortraitGallery` restores the session workspace before uploading replacement
media, then invokes the declared runtime through the shared plugin approval flow.
Approval retries reuse the uploaded media reference. Runtime failures remain
visible to the player, including failed results returned in an HTTP-success response.

`Icon.name` and plugin panel icons use a bounded protocol allow-list so a
plugin cannot pull the complete Lucide library into the client bundle. Current
names are: `anchor`, `backpack`, `book-marked`, `book-open`, `book-user`,
`brain`, `calendar-days`, `check-circle-2`, `compass`, `dices`, `gem`,
`handshake`, `headphones`, `heart`, `id-card`, `image`, `loader`, `map`,
`map-pin`, `megaphone`, `mic`, `network`, `scroll-text`, `search`, `shield`,
`skull`, `sliders-horizontal`, `sparkles`, `swords`, `turtle`, `user`,
`user-search`, `users`, `users-round`, `wand`, `waves`, and `x-circle`.
PascalCase aliases such as `BookOpen` are normalized. Unknown names render no
catalog icon (panel tabs use `HelpCircle` as their fallback).

### Data

| Component             | Purpose                                                                                                                                                                          | Key props                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card`                | Bordered container.                                                                                                                                                              | `variant` (`glow` / `subtle`)                                                                                                                                                                             |
| `CardList`            | Vertical stack of `Card` children.                                                                                                                                               | —                                                                                                                                                                                                         |
| `EntryCard`           | Rich codex-entry card with category icon and rarity accent.                                                                                                                      | `title` _(I18nText)_, `category` (string), `content` _(I18nText)_, `tags` (string[]), `rarity` (`legendary` / `rare` / `uncommon` / `common`), `icon`, `color`, `collapsible`, `defaultExpanded`, `isNew` |
| `StatBar`             | Label + `value/max` numeric bar.                                                                                                                                                 | `label` _(I18nText)_, `value` (number), `max` (number)                                                                                                                                                    |
| `Progress`            | Percent-style progress bar.                                                                                                                                                      | `label` _(I18nText)_, `value` (number), `max` (number)                                                                                                                                                    |
| `Accordion`           | Vertical wrapper for `Section` children.                                                                                                                                         | —                                                                                                                                                                                                         |
| `Section`             | Collapsible header + body.                                                                                                                                                       | `title` _(I18nText)_, `icon`, `defaultOpen` (boolean)                                                                                                                                                     |
| `JsonView`            | Shape-aware render of any JSON value (primitives inline, arrays as tag list, objects as key: value pairs).                                                                       | `value` (any)                                                                                                                                                                                             |
| `EntryList`           | Declarative entries with title, descriptions, badges and labeled fields.                                                                                                         | `items`, `titleField`, optional `idField`, `descriptionFields`, `badgeFields`, `fields`, `dateField`, `footerField`                                                                                       |
| `SceneCastList`       | Present characters from `stage.cast@1`; name, type and description.                                                                                                              | none                                                                                                                                                                                                      |
| `CharacterFieldsView` | Schema-aware renderer for a character's `fields` object. Reads the session World Model's `characterSchema` and groups fields by category (bio/stats/abilities/equipment/social). | `value` (character `fields` object)                                                                                                                                                                       |
| `CharacterAvatar`     | Exact keyed avatar from `character.visual@1`, click to enlarge.                                                                                                                  | `characterId`, optional `size` (default `28`)                                                                                                                                                             |

### Interactive

| Component         | Purpose                                                                                                                                                                                                 | Key props                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`          | Click target with selection-feedback wiring for plugin-declared interactions.                                                                                                                           | `label` _(I18nText)_, `variant` (`default` / `primary` / `danger` / `ghost`), `size` (`compact` / `md`); `on.click.action` = `draftMessage` / `selectChoice` / …                                                                                                             |
| `Input`           | Text input.                                                                                                                                                                                             | `label` _(I18nText)_, `placeholder` _(I18nText)_, `value` (bind via `$bindState`)                                                                                                                                                                                            |
| `Textarea`        | Multi-line text input (monospace, resizable).                                                                                                                                                           | `label` _(I18nText)_, `placeholder` _(I18nText)_, `rows` (number, default `8`), `value` (bind via `$bindState`)                                                                                                                                                              |
| `SearchInput`     | Input with a search glyph.                                                                                                                                                                              | `placeholder` _(I18nText)_, `value`                                                                                                                                                                                                                                          |
| `Select`          | Dropdown.                                                                                                                                                                                               | `label` _(I18nText)_, `options` (`[{ value, label }]`), `value`                                                                                                                                                                                                              |
| `Switch`          | Boolean toggle.                                                                                                                                                                                         | `label` _(I18nText)_, `checked` (bind via `$bindState`)                                                                                                                                                                                                                      |
| `FilterBar`       | Horizontal toggle group (pick-one-of-many).                                                                                                                                                             | `options` (`[{ value, label, icon? }]`), `value`                                                                                                                                                                                                                             |
| `Tabs`            | Tab strip. Bind active value via `$bindState`; optional `counts` map suffixes labels with `(N)`.                                                                                                        | `tabs` (`[{ value, label, icon?, color? }]`), `value`, `counts` (`Record<value, number>`)                                                                                                                                                                                    |
| `FilterContainer` | Stateful container: owns search + tab state internally, renders a registered per-item component for each filtered row. See `apps/web/src/lib/catalog/interactive-renderers.tsx` for the implementation. | `items`, `searchPlaceholder`, `searchFields` (path[]), `filterField`, `filterTabs`, `itemComponent` (registry name), `itemPropMap` (`{ propName: itemPath }`), `itemLiteralProps`, `itemKeyField`, `emptyMessage`, `showCounts`, `footer` (string or `{ component, props }`) |

### Form

| Component      | Purpose                                    | Key props                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Form`         | Bordered form container.                   | —                                                                                                                                                                                                                                                                 |
| `FormHeader`   | Title bar for a `Form`.                    | see `apps/web/src/lib/catalog/session-renderers.tsx` (props pass through to the header layout)                                                                                                                                                                    |
| `FormField`    | Single labelled, typed field.              | `fieldType` (`text` / `textarea` / `number` / `select` / `checkbox`), `min`, `max`, `step` (number fields), `label` _(I18nText)_, `placeholder` _(I18nText)_, `required` (boolean), `options` (`[{ value, label }]`), `value` (bind via `$bindState`), `disabled` |
| `SubmitButton` | Primary submit button with disabled state. | `label` _(I18nText)_, `disabled` (boolean); emit `click` via `on.click`                                                                                                                                                                                           |

Number fields bind a number when nonempty; checkboxes bind a boolean. Browser input
constraints improve interaction but do not replace server validation. Forms created
through `create-form` retain their declared field types and constraints at submission;
plugin validators can enforce rules across fields before writes are committed.
See [form tools](./tools.md#create-form) and [plugin testing](../guide/plugin-testing.md).

### Message

| Component       | Purpose                                                        | Key props                                                                                        |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PlayerMessage` | Right-aligned player chat bubble (with a Paper-theme variant). | `content` (string)                                                                               |
| `Alert`         | Info / success / warning / error notification.                 | `level` (`info` / `success` / `warning` / `error`), `title` _(I18nText)_, `message` _(I18nText)_ |

### Visualization

| Component         | Purpose                                                                                                                                          | Key props                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `GraphCanvas`     | Force-directed graph via `react-force-graph-2d` (lazy-loaded, ~60 KB gzip). Reads `pluginData[pluginId][nodesNamespace]` and `[edgesNamespace]`. | `pluginId`, `nodesNamespace`, `edgesNamespace`, `height?` |
| `WorldDimensions` | Renders the active world's structured dimensions (geography / factions / power system / …). Reads from session context; no bindings required.    | —                                                         |

`GraphCanvas` refreshes node summaries and relationship text on metadata-only
plugin-data updates. The simulation retains its node identities, positions and
pins; only topology changes (including changing either endpoint of an existing
edge ID) publish a new simulation data wrapper. Expired edges are omitted whenever
`invalidAt` is defined, including turn `0`. Selection
highlighting computes direct neighbors once per data/selection change and uses
constant-time membership checks while painting nodes.

### Multimodal

| Component          | Purpose                                                                                                                                                                   | Key props                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AssetRender`      | Surfaces a single `AssetGenerateView` proposal, routed by `view.modality` to the modality-specific renderer (image / audio / generic link).                               | `view` (`AssetGenerateView`), `sessionId?` (overrides active-session lookup) |
| `AssetTurnSidebar` | Fans out every generated asset recorded for a turn (from `state.assetsByTurn`, populated by the `asset.generated` SSE handler). Renders nothing for turns with no assets. | `turnId`, `sessionId?`                                                       |

## Summary

48 components total as of this writing. Authoritative inventory: the exported `covelRegistry` in `apps/web/src/lib/catalog.tsx`; renderer implementations live under `apps/web/src/lib/catalog/`. If you add a new component:

1. Add its exact name to `PLUGIN_UI_COMPONENT_NAMES` in `packages/shared/src/types/plugin-ui.ts`, then register its renderer in `covelRegistry`. The typed registry makes a missing or extra mapping fail TypeScript checks.
2. Add a row here in the matching section.
3. If it accepts user-facing strings, make sure they flow through `resolveI18n` / `useI18nResolver()` so locale switching re-renders the subtree.

## Structured list props and actions

Runtime schemas live in `packages/shared/src/schemas/catalog.ts`. Lists accept
an array of records or, except `CandidateList`, a key-to-record object. Object
entries receive a `key` field. Field selectors use dot-separated paths relative
to each record, including array indexes. `fields` entries are `{ path, label? }`;
labels support I18nText. Plugins map their own persisted shape in their UI spec.
The component does not read plugin storage.

`CandidateList.candidates` is an array. Its default selectors are `id` and
`content`; `hiddenWhen: { field, equals }` hides selected records while retaining
them in the action scope. `acceptedId` marks the current selection. Draft/send
use session actions; optional accept/regenerate actions invoke the supplied RPC.

A catalog action is `{ pluginId, runtimeId, payload, label? }`. Each plugin ID
must be the spec's literal owner ID. Payload values are literal unless a value
is exactly `{ "from": "path" }`; these selectors read `item` (current row),
`props` (component props), or `upload` (the uploaded MediaRef for a portrait
replacement). For example:

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

RPC actions use the shared workspace hydration and approval flow. Uploads are
prepared only after hydration and reused across approval retries. The owning
plugin validates the payload and implements business rules such as replacing a
default portrait while retaining other variants. Old plugin-specific component
names and cross-plugin avatar bindings are removed; development UI specs must
be updated to this contract.

`JobList.relatedMedia` optionally links supplied media records to a row:
`{ items, itemField, matchField, refField?, idField?, titleField? }`. The host
compares the job's `itemField` value to each media record's `matchField`; empty
values do not match. This preserves linked previews without knowing a prompt
field or reading a second plugin namespace.
