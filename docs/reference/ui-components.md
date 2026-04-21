# UI Component Catalogue

Reference for the json-render components available to plugin UI specs. This page is the catalogue — for how panels and message blocks are discovered, wired, and rendered, see [docs/reference/ui-panels.md](./ui-panels.md).

> Chinese translations welcome.

## Authoring tip

- **Registry location** — `apps/web/src/lib/catalog.tsx` exports `covelRegistry`. Plugins can only use components registered there; the framework controls the vocabulary, plugins compose from it.
- **Reference from a plugin** — in your `ui/*.json` spec, set `"component": "<Name>"` exactly as it appears below. The spec is discovered via `PLUGIN.md` frontmatter (`ui.right` / `ui.message` / `ui.left`).
- **Validate** — any CJK string inside spec JSON must be wrapped as `I18nText` (see [ui-panels.md §I18nText](./ui-panels.md#插件-ui-文本-i18ntext-规范)). Run `pnpm check:i18n` — it wraps `check-plugin-i18n` and blocks bare Chinese literals.
- **Discover new components added after this doc** — the full list is always grep-able:

  ```bash
  rg ": ComponentRenderer = " apps/web/src/lib/catalog.tsx
  rg "^  [A-Z][a-zA-Z]+," apps/web/src/lib/catalog.tsx   # registry entries
  ```

  If a component you see in the code is missing from this page, add it — matching files in the working tree are the source of truth.

## Data bindings cheat sheet

| Need | Write |
|------|-------|
| Read state | `{ "$state": "/path" }` |
| Two-way bind state | `{ "$bindState": "/path" }` |
| Iterate array | `repeat: { "statePath": "/path", "key": "id" }` |
| Current item field | `{ "$item": "field" }` |
| Two-way bind item field | `{ "$bindItem": "field" }` |
| Current index | `{ "$index": true }` |
| Resolve i18n | pass any `I18nText` value (`{ "zh": "…", "en": "…" }`) to any `content` / `label` / `placeholder` / `title` / `message` prop |

## Components

### Layout

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `Stack` | Vertical stack of children. | `gap` (string; styling pass-through) |
| `Row` | Horizontal row of children. | `gap`, `align` (`center` / `start` / `end`) |
| `Grid` | CSS grid. | `cols` (number) |
| `Separator` | Horizontal rule. | — |

### Display

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `Text` | Paragraph text with variant controls. | `content` *(I18nText)*, `variant` (`muted`), `weight` (`bold`), `size` (`xs` / `sm` / `lg`), `align` (`center`) |
| `Badge` | Small coloured pill. | `label` *(I18nText)*, `color` (`red` / `amber` / `blue` / `green` / `purple` / `cyan`) |
| `Icon` | Lucide icon by name. | `name` (kebab-case, e.g. `book-open`), `size` (`xs` / `sm` / `md` / `lg`) |
| `TagList` | Flat list of string tags. | `tags` (string[]) |
| `Prose` | Narrative paragraphs with `**bold**` support, split on double newline. | `content` (string) |
| `Source` | Small attribution label. | `label` (string) |

### Data

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `Card` | Bordered container. | `variant` (`glow` / `subtle`) |
| `CardList` | Vertical stack of `Card` children. | — |
| `EntryCard` | Rich codex-entry card with category icon and rarity accent. | `title` *(I18nText)*, `category` (string), `content` *(I18nText)*, `tags` (string[]), `rarity` (`legendary` / `rare` / `uncommon` / `common`), `icon`, `color`, `collapsible`, `defaultExpanded`, `isNew` |
| `StatBar` | Label + `value/max` numeric bar. | `label` *(I18nText)*, `value` (number), `max` (number) |
| `Progress` | Percent-style progress bar. | `label` *(I18nText)*, `value` (number), `max` (number) |
| `Accordion` | Vertical wrapper for `Section` children. | — |
| `Section` | Collapsible header + body. | `title` *(I18nText)*, `icon`, `defaultOpen` (boolean) |
| `JsonView` | Shape-aware render of any JSON value (primitives inline, arrays as tag list, objects as key: value pairs). | `value` (any) |

### Interactive

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `Button` | Click target with selection-feedback wiring for plugin-declared interactions. | `label` *(I18nText)*, `variant` (`default` / `primary` / `danger` / `ghost`), `size` (`compact` / `md`); `on.click.action` = `draftMessage` / `selectChoice` / … |
| `Input` | Text input. | `label` *(I18nText)*, `placeholder` *(I18nText)*, `value` (bind via `$bindState`) |
| `SearchInput` | Input with a search glyph. | `placeholder` *(I18nText)*, `value` |
| `Select` | Dropdown. | `label` *(I18nText)*, `options` (`[{ value, label }]`), `value` |
| `Switch` | Boolean toggle. | `label` *(I18nText)*, `checked` (bind via `$bindState`) |
| `FilterBar` | Horizontal toggle group (pick-one-of-many). | `options` (`[{ value, label, icon? }]`), `value` |
| `Tabs` | Tab strip. Bind active value via `$bindState`; optional `counts` map suffixes labels with `(N)`. | `tabs` (`[{ value, label, icon?, color? }]`), `value`, `counts` (`Record<value, number>`) |
| `FilterContainer` | Stateful container: owns search + tab state internally, renders a registered per-item component for each filtered row. See the code comment block in `catalog.tsx` for a full spec example. | `items`, `searchPlaceholder`, `searchFields` (path[]), `filterField`, `filterTabs`, `itemComponent` (registry name), `itemPropMap` (`{ propName: itemPath }`), `itemLiteralProps`, `itemKeyField`, `emptyMessage`, `showCounts`, `footer` (string or `{ component, props }`) |

### Form

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `Form` | Bordered form container. | — |
| `FormHeader` | Title bar for a `Form`. | see `catalog.tsx` (props pass through to the header layout) |
| `FormField` | Single labelled field (text or select). | `fieldType` (`text` / `select`), `label` *(I18nText)*, `placeholder` *(I18nText)*, `required` (boolean), `options` (`[{ value, label }]`), `value` (bind via `$bindState`), `disabled` |
| `SubmitButton` | Primary submit button with disabled state. | `label` *(I18nText)*, `disabled` (boolean); emit `click` via `on.click` |

### Message

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `PlayerMessage` | Right-aligned player chat bubble (with a Paper-theme variant). | `content` (string) |
| `Alert` | Info / success / warning / error notification. | `level` (`info` / `success` / `warning` / `error`), `title` *(I18nText)*, `message` *(I18nText)* |

### Visualization

| Component | Purpose | Key props |
|-----------|---------|-----------|
| `GraphCanvas` | Force-directed graph via `react-force-graph-2d` (lazy-loaded, ~60 KB gzip). Reads `pluginData[pluginId][nodesNamespace]` and `[edgesNamespace]`. | `pluginId`, `nodesNamespace`, `edgesNamespace`, `height?` |
| `WorldDimensions` | Renders the active world's structured dimensions (geography / factions / power system / …). Reads from session context; no bindings required. | — |

## Summary

35 components total as of this writing. Authoritative inventory: the exported `covelRegistry` in `apps/web/src/lib/catalog.tsx`. If you add a new component:

1. Register it in `covelRegistry` with a short doc comment above the renderer.
2. Add a row here in the matching section.
3. If it accepts user-facing strings, make sure they flow through `resolveI18n` / `useI18nResolver()` so locale switching re-renders the subtree.
