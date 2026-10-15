# Front-End Panel Architecture

This page explains where plugin content appears in the session screen and how it is shown: the right-side panels, plugin cards in chat messages, stage mode, and the status display at the top. Anyone who writes plugin UI or maintains the front end needs it.

The basic idea has one rule. A plugin describes its UI in a JSON document (called a **UI spec** below), and the framework finds it, connects the data, and draws it. A plugin does not write React code.

- For what each component is and which properties it has, see the [component catalogue](./ui-components.md).
- For how to build a panel, see [plugin UI](../plugins/ui.md).

> [!NOTE]
> The DashScope / OpenAI image generation and MiMo TTS described here come from the [official community plugin repository](https://github.com/covel-ai/covel-plugins). They show up, with their tools and UI, after you install them and authorize them in a session.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Session ID | Phase | Execution Status                  │
├──────────────────────────┬──────────────────┬───────────────────┤
│  Center: Message Area    │                  │  Right: Plugin    │
│  ────────────────────    │                  │  Panels           │
│                          │                  │  ──────────       │
│  - Turn messages         │                  │  vertical bar     │
│  - Plugin message surface│                  │  ┌──┐             │
│  - Prose / Form / Alert  │                  │  │  │ World       │
│  - Guide / Codex         │                  │  │  │ Character   │
│                          │                  │  │  │ World Data  │
│                          │                  │  │..│ (more)      │
│                          │                  │  └──┘             │
│  Player Input            │                  │  Panel Content    │
│  [Your action...]   [→]  │                  │  (json-render)    │
└──────────────────────────┴──────────────────┴───────────────────┘
```

The navigation position and the vertical icon bar on the right in the diagram show the `classic` layout. Theme packages can change these structures with `layout`: an icon navigation on the left, text tabs, a scene picture that fills the session area, and so on. See [theme packages §3.1](./theme-packages.md#31-layout-presets-layout).

A layout changes only where things are placed. How panels are found, grouped and ordered, and how data flows, do not change with the layout. A plugin declares `ui.right` / `ui.message` once, and every layout renders it from the same spec.

## Session Toolbar, Player Status and Scene HUD

The toolbar and status display at the top of a session use only the kernel's own data. They do not read any plugin's data. So they work for every world. When a piece has no data, that piece is not shown.

| Shown content                   | Data source                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World name, turn count          | `WorldRecord.name`, `SessionRecord.completedPlayerTurns`                                                                                                                                                       |
| Current scene name              | `name` in the `stage.backdrop@1` slot                                                                                                                                                                          |
| Player stat gauges              | Session World Model: character records with `type: "player"`, plus attributes in the character schema with `category: "stats"`, `type: "number"`, and both `min` and `max` declared; up to 4 items             |
| Carried items                   | String items of the `type: "array"` attributes with `category: "equipment"` on the same player character record, merged in schema order                                                                        |
| Characters on stage (scene HUD) | The actors in `stage.cast@1` who have not left (up to 3), with avatars from `character.visual@1` looked up by character ID; only the name is shown when there is no picture                                    |
| "Speaking" marker               | The last attributed paragraph in `paragraphSpeakers` of `stage.dialogue@1`; shown only when that name matches the `displayName` of an actor on stage                                                           |
| Chapter banner                  | In a layout with `backdrop: "banner"`, the world header image, the world name and the first three tags, shown above the first message                                                                          |
| Status summary                  | The `session.summary@1` slot: a few lines that any plugin can provide and that should be seen at a glance, such as the current goal, the time and the inventory. See [Session summary](#session-summary) below |

Where this content goes:

- In a layout with `panelTabs: "bar"`, the player name, stat gauges and carried items are fixed below the tabs of the right-side panel.
- In a layout with `backdrop: "scene"`, they are drawn together with the characters on stage, over the lower-left corner of the scene picture. This area is called the scene HUD.
- The scene HUD needs a session area that is wide enough (about 66rem). When it is not wide enough, the HUD gives way to the story bar, and the status is shown in the right-side panel instead. The two never appear at the same time.
- With `backdrop: "scene"` and a scene name, the toolbar shows the scene name as a large title, and the world name and turn count are shrunk into one line above it.

How world authors and plugin authors get content to appear here:

- To show a value as a gauge, declare it as a `stats` attribute with a range in the character schema. A `stats` number with no declared range is shown as a line of numbers, up to 4 items.
- To make an item appear in carried items, declare it as a string array of the `equipment` category.
- Neither of these needs plugin UI.
- A plugin's own data (quests, inventory, time) does not go into character records. It appears in the same place through the `session.summary@1` slot.

To the right of the toolbar are the "Text / Stage" switch, settings, the "More" menu, and the right-side panel toggle. Detailed view, raw view, Studio Config, back to the config page, and Debug Traces are inside "More".

## Navigation Across Pages

Another page can jump into a session with a parameter and ask for a panel to be opened:

```text
/session?sid=<sessionId>&panel=plugins|images
```

- This request is used only once. After the session is restored and `GameView` has mounted, the page handles the request and removes the `panel` parameter from the address.
- On a phone, the request is not swallowed by the drawer: the page waits until the drawer and the asynchronously loaded UI specs are both ready, and only then selects the target panel.
- The Images entry opens only a right-panel spec declaring top-level `navTarget: "images"`; icons do not assign navigation destinations. If several panels declare it, the first by `groupOrder` and load order wins. Undeclared panels remain manually accessible; community image plugins must add this field to their gallery spec. After a successful load, a missing target (including an explicitly requested plugin panel) clears the request and shows “This panel is not available in this session.” Later spec reloads do not replay it. A failed load retains the request until the player retries loading.
- When the session ID changes, the session view is rebuilt as a whole. This keeps drafts and panel selections from mixing with the previous session.
- The debug page switches its data by the `sid` in the address. When you return to the session from the debug page, the ID currently being viewed also takes priority.

## Right Panels (Plugin-Driven)

The right-side panels are the main place where plugins show their state. First, some behavior that players can see directly:

- The session view keeps the tabs, the specs and the interaction state. On a phone, closing the drawer and opening it again keeps them.
- When a panel fails to load, the error and a retry button are shown. A panel that loaded successfully before stays on screen.
- Read-only plugin cards in past turns are mounted only when they are expanded.
- The execution status shows why a runtime was skipped. After the subscription drops, you can retry it by hand. When a normal action stream ends, the background subscription is restored; this does not count as a network reconnect.
- The local display cache for execution steps merges updates that arrive within 250ms into one update. It keeps at most the latest 500 lines, and it saves what has not yet been written when you leave the session. Real recovery still depends on the server's execution records.
- When the selection, the font, a menu or the size of a container changes, the tab bar keeps the current tab visible. Horizontal text tabs are centered. The vertical icon bar scrolls only as far as needed to show the selected item.

### Design Principles

- **A plugin's status panel is declared by `ui.right`.** It appears together with the built-in "World" document entry from the framework. The raw "Database" tab appears only after you open the developer view. See below. Lorebook has only an HTTP API. See the note at the end of the [World document](#world-document-framework-owned-tab) section.
- **The framework does not know specific plugins.** It finds panels through `/api/ui-specs`.
- **It renders with json-render.** A plugin provides a JSON spec, and the framework provides a fixed set of components (the catalog).
- **The data comes from pluginData.** When plugin data changes, the server sends a `plugin-data.changed` SSE event, and the panel updates.

### Panel Discovery Flow

```
session created → GET /api/ui-specs?sessionId=<id>
  → server filters by the session's active set (session plugin scope)
  → { right: [...], message: [...], diagnostics: [...] }
  → tabs are generated from right[] (icon + label)
  → each tab maps to one json-render Renderer
  → pluginData[pluginId][namespace] is injected as state
```

> [!NOTE]
> A request without `sessionId` returns every plugin in the registry snapshot. It is used for startup and debugging. `right-panel.tsx` clears its state when you switch sessions and fetches again with the new sessionId, so no tabs from the previous session are left behind.

When you switch sessions, these things also happen:

- The selected group, the sub-panels and their local UI state are reset together.
- Plugin data is loaded with the target sessionId, so a response from an old session cannot be written into the current one.
- When the selected plugin group is removed, the view goes back to the "World" document.
- The vertical navigation can scroll on its own, and the narrow-screen overlay can hold a very long list of panels.

**The Database tab is a developer view.** It lists, row by row and as stored, every public plugin row, including content that is written only for the narrator to see, such as secrets on a character card. So it does not appear in the play screen by default.

- When the player turns on "Developer view" (`ui.developerView`, off by default) under "General" in Settings, an extra "Database" tab appears in the right-side panel.
- When it is turned off, the tab and its content are removed together, and an `open-database` navigation request goes back to the "World" document.
- The `/debug` page always shows the full view.

The Database panel's manual refresh, its retry after a failure, and its automatic refresh triggered by status events all use one request lifecycle. After the session or the refresh version changes, data and errors from old requests are ignored. They also cannot change the loading state of the current request.

### Currently Registered Panels

The second column is the panel ID, which is the `id` in the UI spec. Every right-side panel of a built-in plugin must be listed in this table (a test checks this).

<!-- prettier-ignore -->
| Plugin/runtime | Panel ID | Icon | group | Data namespace | Description |
| --- | --- | --- | --- | --- | --- |
| affinity | affinity | heart | affinity | affinity | Affinity panel (two-way player↔NPC score bar + tier badge + reason for the latest change) |
| char-creator | character | users | character | session.characters | Character list (its type is defined by the current character schema) |
| character-blueprint | character-presence | image | character-art | presence | Character portrait gallery (`PortraitGallery`, read-only display, the player can upload to replace an avatar, `alwaysRender`) |
| codex | codex | book-open | codex | entries | Knowledge codex |
| core-quest | core-quest | scroll-text | core-quest | quests | Quest log (in progress, with a checklist of objectives / completed / failed groups) |
| dice-check | dice-check-panel | dices | (none) | checks | Check records (a reverse-order list of receipts: dice formula / success or failure colors / critical emphasis, `alwaysRender`) |
| inventory | inventory | backpack | inventory | items | Inventory (equipped group + backpack list, quantity badge + tags pill, `alwaysRender`) |
| dashscope-image-gen · openai-image-gen | `<plugin>-gallery` | image | image-studio | images | Story illustration gallery (`MediaGallery`, `alwaysRender`); each of the two image plugins has its own, and both group IDs are `image-studio`. Both provide the single-provider extension point `media.image-flow@1`, so only one of them can be enabled in the same session |
| dashscope-image-gen · openai-image-gen | `<plugin>-jobs` | loader | image-studio | \_jobs | Generation job view (`JobList`, `alwaysRender`) |
| dashscope-image-gen · openai-image-gen | `<plugin>-trigger` | wand | image-studio | (none) | "Generate image" manual trigger button (`expectsBackgroundFollower`, `alwaysRender`) |
| mimo-tts | mimo-tts-audio-tab | headphones | tts-studio | tracks | Narration voice playlist (`AudioPlayer`, `alwaysRender`) |
| living-world-rules | living-world-rules | book-marked | world-data | rules | World rules (long-term settings / taboos, read-only; seeded by the world-data import, a sub-tab of the `world-data` group) |
| memory | memory | brain | (none) | blocks | Memory blocks. The memory plugin updates its own memory blocks in a background job after the turn, and the panel displays them |
| npc-graph | npc-graph | network | npc-graph | nodes + edges | NPC relationship graph (force-directed visualization) |
| scene-stage | scene-stage | image | scene-stage | stage | Current scene stage (read-only): scene name + day/night badge + `sourceLabel` status text (shows "No background" when the scene is not in the registry) |
| scene-stage | scene-cast | users-round | scene-stage | active-cast | Characters on stage in the current scene (read-only, only name + role; the internal selection signal stays in plugin_data, `alwaysRender`) |
| tabletop-rules | tabletop-rules | dices | (none) | checks | Attribute check entry button (calls `tabletop-rules/check` to open the check form, `alwaysRender`) |
| world-init | world-overview | map | world-data | session.dimensions | Current value and version of any dimension (read-only during play), plus pending settlement recovery (`alwaysRender`) |
| world-init | world-schema | sliders-horizontal | world-data | session.characterSchema | Character attribute schema |
| world-time | world-time | calendar-days | (none) | clock | Current world time (`/current/display` + reason for the change) |
| world-time | time-definition | calendar-days | (none) | definitions | Time rules (the current calendar definition, read-only; when there is no definition, it explains the default calendar) |

Notes on some groups:

- **The `world-data` group** (group name "World Data") brings together three specs: `world-overview` and `world-schema` from `world-init`, and `living-world-rules` from `living-world-rules`. They form one outer tab, and horizontal sub-tabs switch between the overview, the attributes and the world rules. The `WorldDimensions` in the overview reads the public current values of the session directly. It does not build them from `entries` or the world's initial values. A dimension also no longer has a copy in a constant lorebook.
- **The `character` group** is the character list from `char-creator`. It reads `session.characters` from the session's World Model, which is the live state of the current save. A world's characters are imported from its character file into the World Model, and a plugin's data about a character (such as the roleplay notes of `character-blueprint`) is stored in the plugin's own namespace, keyed by the character's ID. Characters are created and imported through the World Model. Plugins do not copy characters to each other.
- **The `npc-graph`** panel uses `dataSource.bindings` to connect its own `nodes` and `edges` namespaces into the panel state. It then passes them as properties to `GraphCanvas`, which draws the relationship graph (`react-force-graph-2d`, loaded on demand).
- **The `memory`** package registers the `prompt.segment@1` and `memory.block-definitions@1` services and a right-side panel. `runtimes/extract/RUNTIME.md` reads the frozen `turn-digest@1` and, as a background job with `settle: before-next-execution`, updates this plugin's `blocks` namespace. The panel reads these blocks directly. Its prompt segment is at the turn level and sits in the turn context after the history. In a session where this plugin is disabled, extraction does not run, the next turn does not wait for its job, and no memory is injected.

### Dynamic Dimensions Overview and Corrections

The `WorldDimensions` component shows the current values of the world's dimensions. The generic `SessionDimensionsPanel` connects it to `dimensions` and `dimensionSettlements` in the session snapshot, along with trusted provider and recovery metadata. It does not take a different branch for each dimension ID.

Each public dimension item is `{name,description?,schema,value,version}`. The panel shows the name, the stable ID and the version of the value. It does not show the initial value or the maintenance rules.

- **Display.** Scalars are shown directly. Objects are shown field by field. Arrays, or objects keyed by dynamic names, can be shown as rows and columns according to the schema's properties, with column headers taken from `title` or the field name.
- **Read-only and editing.** The dimension panel in the play screen is read-only. Only the pending settlement recovery card can be acted on. Field editing (`allowValueEditing`) is turned on only in the session data view of the debug page. When it is on, the basic schema supports field editing and adding or removing array items and named records. Complex nested values have a clear JSON editing entry.
- **Validation.** The client and the submit boundary share `validateDimensionValue`. Missing values, nullable values and out-of-range errors are not fixed by forcing a type conversion. `x-i18n` nodes are shown in the right locale. Plain JSON does not try to guess translations.
- **Saving.** A save sends the `expectedVersion` from when editing started. It sends a runtime RPC through the host-specified `editorRuntimeId`, and does not bypass the reserved namespace to write directly. When a conflict happens, the panel refreshes the current value and shows an error. The player checks it and submits again. Nothing is overwritten silently.
- **Pending settlement card (pending).** The card shows the logical turn of the source and the reason for the failure. It offers three actions: retry, mark as handled manually, and mark as skipped. Retry calls `trackerRuntimeId` directly and includes the receipt `sourceTurnId`. The last two are written as final states by the editor against `source.resultId`. An ordinary saved value does not clear a pending state.
- **When editing is disabled.** While a turn is running or a request is being processed, the edit buttons are disabled. After an action, the session view is fetched again to check the committed values and receipts. The `submitted` value returned by the runtime is not treated as saved to the database.
- **When there is no recovery entry.** If there is no trusted recovery entry, the panel is read-only. It does not fall back to the author's initial value.

Do not confuse the two editors:

- The world author's editor edits the full, open definition map. It allows any legal ID. The nine genre structures are only optional templates.
- The debug page edits the current values of a session. It cannot create new definitions or change schemas.

For the raw declaration format, the rebuild requirements for development data, and the recovery calls, see [World Data](./world-data.md#dynamic-world-dimensions-dimensions) and [API](./api.md#dimension-editing-and-recovery-of-pending-settlements). Hidden events currently have no editor for their triggers or payloads (#97).

### World Document (Framework-Owned Tab)

The "World" tab is provided by the framework itself. It sits next to the plugin tabs, but `/api/ui-specs` does not affect it.

- **Data source**: the `WorldRecord.lore` of the current session, which is `worlds/<id>/WORLD.md`. It is resolved by `defaultLocale`: first an exact match for the locale, then the main language of the same writing system, and finally the main file `WORLD.md`. The content is written into the store at startup by `world-seed-loader`.
- **Interaction**: rendered as Markdown (`@/components/ui/markdown`, `react-markdown` + `remark-gfm`). When `lore` is empty, `description` is shown. If that is also empty, "No world document" (`worldDocumentEmpty`) is shown.
- **Narrator-only text**: content between `<!-- narrator-only -->` and `<!-- /narrator-only -->` is not shown (`playerVisibleLore`, in `@covel/shared`). When the whole file is marked, it is treated as an empty `lore`. The "World Document" on the session-prep screen and the world detail page use the same function. For how to write it, see [World Data](./world-data.md#narrator-only-lore-narrator-only).
- **Implementation**: `apps/web/src/components/session/world-document-panel.tsx`. It is mounted in `right-panel.tsx` as the `world` tab, and `game-view.tsx` passes the current `world: WorldRecord | null` to it.
- **Isolation rule**: the code of this tab belongs to the framework. It depends only on the public fields of `WorldRecord` and does not know any plugin ID.

> [!IMPORTANT]
> Hiding `narrator-only` content is to avoid spoilers, not to keep secrets. The full text is still in `WorldRecord.lore`.

> [!NOTE]
> The Lorebook is still served by the HTTP API (`GET/PATCH/DELETE /api/sessions/:id/lorebook[/:entryId]`). No built-in interface uses it at the moment. When it needs to be shown, a plugin can build its own view with a `ui.right` JSON spec.

### How to Declare a Panel

A plugin lists the paths of its JSON files under `contributes.ui.right` in `PLUGIN.md`:

```yaml
# PLUGIN.md
contributes:
  ui:
    right:
      - ./ui/my-panel.json
```

When this page says `ui.right` or `ui.message`, it means these keys under `contributes.ui`. These are the two supported placements; a right panel can also select the stage decision area with `surfaces`. Other placements, including the removed `left`, are ignored with a log message at load and reported as unknown fields by `pnpm validate:plugin`.

### JSON Spec Format

```json
{
  "specVersion": 1,
  "id": "world-entries",
  "group": "world-data",
  "groupLabel": "World Data",
  "label": "Entries",
  "icon": "book-marked",
  "dataSource": { "namespace": "entries" },
  "emptyState": {
    "message": "World entries not yet generated, waiting for initialization…"
  },
  "view": {
    "component": "Accordion",
    "repeat": { "statePath": "/entries", "key": "key" },
    "children": [
      {
        "component": "Section",
        "props": { "title": { "$item": "key" }, "icon": "chevron-right" },
        "children": [
          {
            "component": "JsonView",
            "props": { "value": { "$item": "value" } }
          }
        ]
      }
    ]
  }
}
```

Key fields:

| Field                  | Description                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specVersion`          | The version of the UI spec. It can be left out, and then it is treated as v1. A version higher than the server supports is rejected. See [Spec validation and versions](#spec-validation-and-versions)                                                        |
| `id`                   | The unique identifier of the panel                                                                                                                                                                                                                            |
| `group`                | Panels with the same `group` are merged into one outer tab                                                                                                                                                                                                    |
| `groupLabel`           | The name of the merged outer tab. Optional; when left out, the `label` of the first spec is used                                                                                                                                                              |
| `label`                | The panel's own name, shown on its sub-tab                                                                                                                                                                                                                    |
| `shortLabel`           | The short name used on the tab bar. Optional. See [activity-bar short labels](#activity-bar-short-labels)                                                                                                                                                     |
| `icon`                 | The icon name (Lucide, kebab-case). Only the icons the framework allows can be used. For the full list, see [Component catalogue / Display](./ui-components.md#display)                                                                                       |
| `dataSource.source`    | Generic read-only session source: `session.characters` (keyed by character ID) or `session.characterSchema` (the schema itself, with attributes at `/attributes`). Takes precedence over `namespace`; missing data is an empty object.                        |
| `dataSource.namespace` | Which data the panel reads: `pluginData[pluginId][namespace]`. `_jobs` is a special value, see below                                                                                                                                                          |
| `dataSource.bindings`  | Optional. Connects up to 8 more of the plugin's own namespaces, see below                                                                                                                                                                                     |
| `emptyState.message`   | The hint shown when the data is empty. See [Empty state rendering](#empty-state-rendering)                                                                                                                                                                    |
| `view`                 | The interface itself: a tree built from catalog components. The web interface runs only this declarative kind of spec. Interface declarations that are not JSON, such as `.tsx` or `.js`, are not supported. The API gives a diagnostic and removes that item |

Session sources update from complete snapshots and committed character/schema events without a plugin-owned copy. Plugin state tables live only under front-end `gameState.tables`; World Model fields such as characters, character schema and dimensions remain separate at the top level. Invalid dimension snapshots show a local panel notice; the opening scene still shows the world name and tags.

**`_jobs`: a virtual data source for background jobs.** When `dataSource.namespace` is set to `_jobs`, the panel receives this plugin's background manual jobs and event jobs (mapped from `_runtime_jobs`). They are keyed by jobId, and each value contains:

- `status`: `pending` / `done` / `failed`
- `runtimeId`, `turnId`, `startedAt`, `completedAt`, `durationMs`
- `message`, `error`, `reason`, `runtimeResults`, `deferredJobs`

`message` appears only on prompt generation jobs queued with `expectsBackgroundFollower`. While it is running, it reads "Generating image prompt". After it is queued behind other jobs, it reads "Image job queued". It is shown in the player's language.

**`dataSource.bindings`: connecting more of your own data.** For example:

```json
{ "nodes": "characters", "edges": "relations" }
```

- The panel receives the data of these two namespaces in the current session under `/sources/nodes` and `/sources/edges`, and refers to them with `$state`.
- Both the names and the namespaces must be fixed strings. They cannot point to another plugin.
- When you switch sessions, these values are refreshed together with the data source. A namespace that does not exist is an empty object.
- The main `namespace` still decides the panel's ordinary data, and whether the panel counts as "empty".

### Spec Validation and Versions

A UI spec is **untrusted plugin input**. Its rules exist once: `pluginUiSpecIssues` in `@covel/shared` (`packages/shared/src/schemas/ui-spec.ts`). `pnpm validate:plugin`, the ZIP install and `/api/ui-specs` all use it when they load a panel, so a spec that passes the check is not dropped in the game for its format.

- **Versions.** `specVersion` can be left out, and then it is treated as v1. A version higher than the host supports (currently `CURRENT_UI_SPEC_VERSION = 1`) is rejected. This way, an old host that meets a new plugin package reports a clear error instead of drawing a broken panel.
- **`webview`.** `entry` points to an `.html` file in the package of at most 512 KiB; `height` is an integer from 80 to 800. `surfaces` can only be `panel` and `stage`.
- **Data ownership.** `pluginId`, `sourcePlugin` and `sourcePluginId` can only name this plugin's ID; `dataSource.bindings` can only be fixed namespaces of this plugin, at most 8.
- **Either `view` or `webview`, not both.** Each spec must declare `view` (an object) or `webview` (an HTML document). If both are present or both are missing, validation fails.
- **Recursive validation of `view`.** The checks cover `component` / `type`, `children`, named `slots`, `repeat`, and the structure of the action bindings in `on` / `watch`. Component names must be in the shared `PLUGIN_UI_COMPONENT_NAMES`. An unknown component produces a diagnostic with its path on the server. `props` and directive expressions are not restricted. They are parsed at runtime by the components and json-render, so plugins can extend the shape of their data.
- **Declarations that are not JSON.** `contributes.ui` accepts only `.json` files. `pnpm validate:plugin` and installation reject any other file; at load such an entry gets a diagnostic, and the other valid JSON specs from the same plugin are still shown. The browser never runs a plugin's component file.
- **When a custom component is needed.** Declare `webview.entry` and provide a separate HTML file. Or compose catalog components and bind the framework's actions. The browser does not import a plugin's `.tsx` / `.js` modules directly.
- **One bad spec does not break the whole response.** A spec that fails validation is removed from where it sits, and the top-level `diagnostics[]` of the response gives the specific diagnostic:

  ```ts
  { pluginId, runtimeId, slot, specIndex, specId?, issues: [{ path, message, code }] }
  ```

  It says which plugin, which field and what the problem is, instead of a vague "Invalid panel spec".

- **How the front end uses these diagnostics.** `right-panel.tsx` prints the diagnostics to the console in development mode. The local fallback message in `plugin-panel.tsx` also includes the spec name and the specific reason: a missing `view`, a `view` that is not an object, or a conversion failure.

UI declarations come from the registry snapshot taken at startup. Static assets are loaded on demand and cached by snapshot. A GET request only reads and filters by the session's active set. It does not scan the plugin directory, and it does not write UI definitions into `plugin_data` (see [api.md](./api.md#get-apiui-specs) for details).

When static assets are read, the real path is checked after symbolic links are resolved. A link that points inside the plugin root is allowed. A link that points to a file or directory outside the root is rejected. When a spec cannot be read or breaks a rule, only that spec is removed, with an explanation in `diagnostics[]` and in the server log; the plugin's other panels are still shown.

### Activity-Bar Short Labels

What name a tab shows depends on the layout's `panelTabs`.

**`panelTabs: "bar"` (horizontal text tabs)**

- Tabs show `shortLabel`. When none is declared, the full `groupLabel` / `label` is shown, without truncation.
- When not all tabs fit, the tab bar can scroll horizontally, and the mouse wheel can scroll it too. The truncated side fades out, and the selected tab stays in the middle.
- At the end of the tab bar there is one more "All panels" button. Clicking it opens a grid of all tabs with their full names.

**`panelTabs: "rail"` (vertical icon bar on the right, activity-bar)**

Each tab has only a very narrow space for text. When no `shortLabel` is declared, the framework cuts `groupLabel` (or `label`) mechanically:

- Chinese text with 2 or more characters → take the **first two characters** (for example, the Chinese for "Core Memory" is cut to its first two characters)
- Several English words → take the first letter of each word, capitalized, up to 3 ("Core Memory" → "CM")
- Anything else → take the first 4 characters

When a cut-off name is not recognizable, or it clashes with another tab's name, declare `shortLabel` at the top level of the spec:

```json
{
  "label": "Core Memory",
  "shortLabel": "Memory"
}
```

```yaml
# locales/zh.yaml
messages:
  Core Memory: 核心记忆
  Memory: 记忆
```

The merge rule is the same as for `groupLabel`: within the same `group`, the first one declared is used. We recommend that every spec in a group sets the same `shortLabel`, so the result does not depend on the loading order.

**Who owns the interface text.** A plugin's group names, short labels, panel labels, buttons and form fields are written in `plugins/<id>/ui/*.json` (in English), and translations are written in `plugins/<id>/locales/<locale>.yaml`. The framework's own i18n dictionary holds only the framework's navigation, system buttons and common status text. When several plugins share one `group`, each plugin's spec should set a matching `groupLabel`. The short label on the tab is decided by the first `shortLabel` in the group.

Implementation: `compactTabLabel()` and `aggregateSpecsIntoGroups()` in `apps/web/src/lib/plugin-panel-tabs.ts`.

### Empty State Rendering

When a panel's namespace has no data (`Object.keys(data).length === 0`), `PluginPanel` does not render the `view`. It shows a single centered italic hint line instead.

**Which sentence is shown**: first the `emptyState.message` declared by the spec. When none is declared, an automatically generated line is used: "`<panel name>` has no data yet, waiting for the game to progress…".

**How to write it**: write the English in the spec, and put the translation in `locales/<locale>.yaml`. See [plugin UI text rules](#plugin-ui-text-rules) below.

```json
"emptyState": {
  "message": "No characters yet…"
}
```

**Convention**: every right-side panel that renders from namespace data **must** declare `emptyState.message`, and the hint must fit the panel's own business. Do not use a generic line. Examples from the built-in panels (English text; each one has a Chinese translation in its locale file):

| Panel spec             | Empty-state hint                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `character-panel.json` | No characters yet. They appear here once the character creation flow is done…                  |
| `codex-panel.json`     | No codex entries yet. They appear here as the story goes on…                                   |
| `memory-panel.json`    | Memory blocks are not set up yet. They fill in automatically after the first turn…             |
| `npc-graph-panel.json` | No characters or faction relations found yet. They appear as the story goes on…                |
| `world-schema.json`    | The character attribute schema is not generated yet. It appears once the world is initialized… |

**`alwaysRender: true` is the exception.** Some panels do not render from namespace data. For example, the `WorldDimensions` in `world-overview.json` reads the session context directly. `MediaGallery` and `JobList` can handle empty lists themselves. Such a spec explicitly declares `"alwaysRender": true` at the top level. The framework only reads that field; it does not enable it automatically by component name. These specs **may leave out `emptyState.message`**, because `PluginPanel` never reaches the empty-state step. See [UI components](./ui-components.md#structured-list-props-and-actions) for component props.

**Implementation**: the `PluginPanel` component in `apps/web/src/components/session/plugin-panel.tsx` (the `isEmpty` check and the `alwaysRender` short-circuit).

### Plugin UI Text Rules

A UI spec is written in one language only: English. Text in other languages goes in the `messages` section of the plugin's `locales/<locale>.yaml` file. On the left is the original English text from the spec, and on the right is the translation:

```json
// ui/codex-panel.json
{
  "label": "Codex",
  "shortLabel": "Codex",
  "emptyState": { "message": "No codex entries yet." },
  "view": {
    "component": "Text",
    "props": { "content": "{{count}} entries collected" }
  }
}
```

```yaml
# locales/zh.yaml
messages:
  Codex: 知识图鉴
  shortLabel|Codex: 图鉴
  No codex entries yet.: 图鉴暂无词条。
  "{{count}} entries collected": 共 {{count}} 条记录
```

Rules:

- **Which properties count as text.** Properties named `label`, `title`, `content`, `message`, `text`, `description`, `placeholder`, `footer`, `tooltip`, `hint`, `help`, `summary` or `subtitle`, and properties whose names end in `Label`, `Title`, `Message`, `Text`, `Placeholder`, `Description`, `Hint` or `Tooltip` (`shortLabel`, `groupLabel`, `searchPlaceholder`, `emptyMessage`, and so on).
- **Translations apply only to these properties.** So a translation file cannot change component names, actions or data paths. The contents of `on` (action parameters), `dataSource` and `watch` are data, and they are not translated.
- **Display labels for data values.** `$map.labels` values and string fallbacks are text too; see [Value-label mapping](./ui-components.md#value-label-mapping). Text inside row templates follows the same rules.
- **When the same English sentence needs two translations**, put the property name and `|` in front of the key. `shortLabel|Codex` applies only to `shortLabel`, and `Codex` is used everywhere else.
- **Text with no translation is shown in English.** Placeholders in a translation (such as `{{count}}`) must match the original.
- **When the English original changes, the old translation no longer matches.** The interface falls back to English, and `pnpm validate:plugin` reports the translation as an error. You do not need to record separately whether a translation is out of date.
- **A spec must not use inline `{ "zh": …, "en": … }` values, and it must not contain Chinese.** `pnpm validate:plugin` and `pnpm check:i18n` reject them.
- **Every interface text of a built-in plugin must have a Chinese translation** (checked by `pnpm check:i18n`). Text that is the same as the English can be repeated as it is. Text with no letters (symbols, numbers) does not need one.

**What the front end receives.** The loader compiles the translations into `I18nText` (`string | Record<LocaleTag, string>`) and passes them to the front end. So `GET /api/ui-specs` still returns values such as `{ "en": "Codex", "zh": "知识图鉴" }`. For the shared resolution rules and fallback order, see [Internationalization](./i18n.md). Components must not decide the locale themselves.

**The front-end resolver.** `resolveI18n(value, locale?)` and `useI18nResolver()` are exported by `apps/web/src/lib/catalog/helpers.tsx`, and the renderers import them from this module directly. All built-in ComponentRenderers call this hook to subscribe to language changes, so when the language switches, the json-render subtree re-renders automatically.

**Validation.** `pnpm check:i18n` runs two scans: `check-no-chinese-literal` (application code) and `check-plugin-i18n`. The second one checks two kinds of content:

- Labels that a player can see, in plugin JSON, manifests and handlers.
- Text sent to the model: in plugins and templates, the descriptions of tools and parameters must be in English.

The files and line counts where Chinese appears in framework source are recorded in the `FRAMEWORK_CHINESE_LINES` table in the script. Any addition or change must update this table explicitly.

### json-render Binding Cheat Sheet

| Need                                       | How to write it                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Read state                                 | `{ "$state": "/path" }`                                                                           |
| Read and write state                       | `{ "$bindState": "/path" }`                                                                       |
| Iterate over a state array                 | `repeat: { "statePath": "/path", "key": "id" }` (a top-level field of the element, **not props**) |
| Iterate over a sub-array inside repeat     | `repeat: { "statePath": { "$item": "items" }, "key": "id" }`                                      |
| Read a field of the current item           | `{ "$item": "field" }` (the field name has no leading slash)                                      |
| Read and write a field of the current item | `{ "$bindItem": "field" }`                                                                        |
| Current index                              | `{ "$index": true }`                                                                              |
| Named slots                                | `"slots": { "header": [{ "component": "Text" }], "content": [{ "component": "Stack" }] }`         |
| Dynamic values and text                    | `{ "$math": "add", "a": 1, "b": 2 }`, `{ "$concat": ["HP ", { "$state": "/hp" }] }`               |

> [!NOTE]
> `repeat.statePath` accepts an absolute state path string that starts with `/`, or, in a nested repeat, `{ "$item": "field" }`. It is not `{ "$state": ... }`. An item's field name cannot have a leading slash: `$item: "key"` is correct, and `$item: "/key"` is wrong. The same holds for `$bindItem`. `pnpm validate:plugin` and the ZIP install check these forms. The error gives the spec file and the path of the node.

**How panel state stays in sync when external data changes.** A panel compares two external data snapshots, one before and one after, and syncs only the parts that differ:

- Deleted fields, and derived indexes that become invalid when an array gets shorter, are cleared. Empty objects are kept.
- `/_invoking` and `/sources` are replaced as a whole, so buttons become usable again after a call finishes.
- For fields whose external value did not change, the player's local edits made with `$bindState` are kept. Draft fields that are not taken by external data are kept too. The same rule applies when a cached panel is reused after switching panels.
- State paths are escaped with JSON Pointer: a `~` in a field name is written as `~0`, and a `/` is written as `~1`.

**How arrays are checked for changes.** Arrays (including the automatically generated `/entries`) are judged by their external content:

- A new array with the same content keeps the existing local edits. When the content or order really changes, the whole array is replaced.
- A recursive comparison checks at most 32 levels. A deep subtree that cannot be confirmed as the same within this range is treated as changed, so the cost of the traversal has a limit.
- An object field whose name is a number is still treated as an object key. It is not quietly taken as an array index.

**Button state and interaction locks.**

- The selected state and the "calling" state of a button are updated from the latest state that the action's dynamic parameters read.
- When panel interaction is locked, the JSON rendering area cannot be used with the mouse or keyboard. The action handler also checks the lock, so a callback that was kept cannot get around the interface lock.
- The lock works like this: `inert` and `aria-disabled` are set on an ancestor container, and the check in the action handler is kept too. While locked, the browser skips keyboard focus on the controls inside, and user input is blocked.
- The catalog's Input / Textarea / Select link localized labels with unique IDs. Switch uses a native button that does not submit forms, and it supports Tab, Space and Enter.
- Control accessibility does not get around the panel lock. No general disabled field has been added to the spec.

### Standard Directives

A directive is a small calculation written in the spec, such as "join these two values". All json-render Providers the framework holds share the same set of directives: the right-side plugin panels, the plugin message surface, and the message blocks bound to a turn.

A directive can be written in any dynamic value position in component props, and it can also be written in `on.<event>.params`. So the parsed result that an action triggered by a button or an input receives matches what is shown.

| Directive    | Use                                                                           |
| ------------ | ----------------------------------------------------------------------------- |
| `$format`    | Format a number, date, currency or percent                                    |
| `$math`      | Add, subtract, multiply, divide, modulo, min/max, rounding and absolute value |
| `$concat`    | Join several dynamic values                                                   |
| `$count`     | Get the length of a string or array                                           |
| `$truncate`  | Truncate text                                                                 |
| `$pluralize` | Choose zero / one / other text by count                                       |
| `$join`      | Join array elements                                                           |

`$t` is not open yet. A plugin's natural-language text goes in text properties and is translated by `locales/<locale>.yaml`, so there are not two sources of translation alongside the existing i18next resources. Strings in directive parameters (for example, the fragments of `$concat`) are not in the translation scope. Text that needs translating should go in a text property.

```json
{
  "component": "Button",
  "props": {
    "label": { "$concat": ["Items: ", { "$count": { "$state": "/entries" } }] }
  },
  "on": {
    "click": {
      "action": "invokeCommand",
      "params": {
        "command": "bag",
        "args": {
          "pageSize": { "$math": "max", "a": 1, "b": { "$state": "/pageSize" } }
        }
      }
    }
  }
}
```

### Development Debugging

A development build mounts the json-render Devtools only on the right-side plugin panel that is currently active.

- Press `Cmd/Ctrl+Shift+J` to open the Spec, State, Actions, Stream and Pick debug panels.
- When you switch to another right-side sub-panel, the inspection target switches with it.
- Plugin message surfaces in the message stream do not mount Devtools, so several instances do not fight over the same shortcut.
- In development, the Devtools load on demand and are not included in the production build.

### Automatic `entries` Array

Plugin data `pluginData[pluginId][namespace]` has the shape `{ key: value }`. The framework derives a `/entries` array from it, in the form `[{ key, value }, ...]`, for `repeat` to iterate over.

The original keys can still be read directly with `$state: "/someKey"`. Both ways can be used at the same time.

### Multiple Panels and Groups (Shared Across Plugins)

**`group` is a global string that can be shared across plugins.** Several plugins, or several specs of the same plugin, that have the same `group` value are merged into one outer tab, and their specs switch with horizontal sub-tabs.

```
┌──────┬──────────────────────────────┐
│ [W]  │ World Data                   │  ← outer tab (group="world-data")
│ [C]  │ [Overview] [Attributes] [Rules]... │  ← sub-tabs (several specs / plugins)
│ [B]  │ ┌──────────────────────────┐ │
└──────┤ │ (current sub-tab content)    │ │
       └──────────────────────────────┘
```

**Two typical uses**:

- Several panels of one plugin: `world-overview` and `world-schema` from `world-init` both declare `group: "world-data"`.
- Combining across plugins: `world-init` provides the overview and attributes, and `living-world-rules` provides the world rules. They all declare `group: "world-data"`, and they are automatically gathered into the same outer tab.

**Merge rules**:

| Field                                               | Behavior                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Same `group`                                        | Merged into one outer tab (switched with horizontal sub-tabs)                                                                                 |
| Different `group` or omitted                        | Separate outer tab (fallback key is `${pluginId}::${specId}`)                                                                                 |
| `groupLabel` / `shortLabel` / `icon` / `groupOrder` | On conflict, the **first declarer wins**, in the order `/api/ui-specs` returns them (the plugin load order)                                   |
| `groupOrder`                                        | Sort order of the outer tab in the activity bar (smaller numbers first, default 500)                                                          |
| `navTarget`                                         | Optional; only `"images"` is supported. Each spec declares its own destination for Images navigation. Omitted specs stay manually selectable. |

**Naming convention**: a group name shared across plugins works like a CSS class name. Authors add their own namespace prefix to avoid conflicts, for example `core.character` or `myorg.combat`. The framework does not add prefixes automatically.

When several plugins share a group, provider switch buttons show each plugin's localized `displayName`, falling back to its ID when no name is available. Every group name follows this rule; a panel's `label` / `shortLabel` does not change the provider name.

**Implementation**: `aggregateSpecsIntoGroups()` in `apps/web/src/lib/plugin-panel-tabs.ts`. It is a pure function and can be tested on its own (see the Playwright smoke test).

### Ordering

- Outer tabs are sorted by `groupOrder`. The sort is stable: tabs with the same `groupOrder` keep their load order.
- Sub-tabs appear in the order in which their specs were added.
- The selection and render state of a sub-panel are identified by `(pluginId, spec.id)`. After reordering, the selected panel is still the same one.
- When the selected panel is removed, the view goes back to the first item of the group.
- Different plugins can use the same `spec.id`. They do not share local UI state.

## Message Area

### Two Rendering Paths

The message area has two paths that run side by side. They use the same json-render catalog.

1. **Turn message path**: `chat-messages.tsx` reads `turn_messages` and SSE events, converts them into json-render specs with `messageToSpec()`, and renders them with `MessageBlockRenderer`. The specific blocks and base components are split under `apps/web/src/components/session/chat-messages/`.
2. **Plugin message path**: in the same file, in the `block.type === "plugin_message"` branch, `ui.message` is discovered through `/api/ui-specs?sessionId=`, and then `PluginPanel` and `plugin_data` render the plugin message surface.

| Path           | Content it carries now                                                                                                                                                                                           | Where it is implemented                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Turn message   | Narrative text, player input, `interaction.requested` forms and choices, notifications                                                                                                                           | `apps/web/src/components/session/chat-messages.tsx`, `apps/web/src/components/session/chat-messages/` |
| Plugin message | Guide suggestion cards, the codex summary for this turn, the dice-check result block, the core-quest change block, the affinity toast, the inventory gain/loss toast, and other plugins' custom message surfaces | `apps/web/src/components/session/chat-messages.tsx` (the `plugin_message` branch)                     |

**Updates for each turn are folded by default.** In the parsed view (`parsed`), the read-only plugin cards of each turn are merged into one collapsed entry, "Turn updates · N". Its summary previews the titles of the first three cards. This keeps the narrative in the main space.

- Folded: `ui.render`, `ui-spec`, and notifications at level info / success, such as codex discoveries, achievements and status changes.
- Not folded: forms, options, confirmations, images, and warning and error notifications.
- Plugin message surfaces (`plugin_message`) stay expanded in the current turn. After a later player message, the disclosure shows the provider’s localized name and “expand to review”, falling back to “Plugin content” when no name is available. Checks, quest updates and suggestions follow the same rule.
- Players can turn on "Expand turn updates" (`ui.expandTurnUpdates`) under "General" in Settings, so they are expanded by default.
- The `detailed` and `raw` views do not fold.
- The theme package's `layout.turnNotes` decides where these updates go: `fold` is the default behavior described above; `inline` expands the latest turn by default; `margin` puts them in a side margin next to the story text when the session area is wide enough.

See `apps/web/src/components/session/chat-messages/turn-updates.tsx` for the implementation.

**Choices look the same everywhere.** Anything the player chooses from is finally rendered as `.ui-choice`:

- `ChoiceList` / `Choice` in a plugin spec;
- The kernel's choice message block (the `choice` block, which the framework turns into a `ChoiceList`);
- The reply variants of `CandidateList` (one click adopts that version; "Draft / Send" is a secondary action below it);
- The decision panel of the stage view.

So choices look the same in every style scheme. A new plugin follows automatically as long as it uses one of these paths.

**Choosing with number keys.** Choices in the current turn can be picked with number keys: pressing 1–9 is the same as clicking the nth choice on the screen.

- When a turn has several groups of choices, the numbers run continuously, with the ones that appear first coming first. The numbers drawn match the keys pressed.
- Disabled choices keep their numbers, but they do not respond.
- No response in these cases: focus is in an input box, a modifier key is held, a dialog or menu is open, or the turn is still running.
- The decision panel of the stage view supports this too.

See `apps/web/src/hooks/use-choice-hotkeys.ts` for the implementation. The numbers are CSS counters (see the `.ui-choice` section of `apps/web/src/styles/ui-components.css`).

### Message Block Declarations

A plugin uses `ui.message` to declare how a block in the message area is rendered:

```yaml
contributes:
  ui:
    message:
      - ./ui/guide-block.json
```

> [!IMPORTANT]
> **A message block appears only after it has data.** A `ui.message` block is rendered only after data has been written into the `message` namespace it declares. So a plugin whose writes can be triggered only by a button inside the block never starts: there is no data on the first screen, the block does not appear, and the button cannot be clicked. `branch-reply` was completely invisible in its early days for this reason.
>
> The write that makes the block appear for the first time must come from a path that is **not manual**: an `auto` runtime (which writes the first data after reading the narrative engine's output), an upstream runtime's `plugin.data` proposal, or a world-data import. `branch-reply` is an `auto` runtime (the default trigger, `stage: post-turn`, after the narrative engine) to write candidate[0]. See [plugins.md § representative implementations](./plugins.md#representative-implementations) for details.

**Turn binding (`__turnId`).** The turn a message block is attached to is decided by `__turnId` in the `message` namespace. There are two ways to write it:

| Style           | How to write it                                                                                           | Result                                                                                | Example                |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| Namespace level | Write `__turnId` at the top level of the namespace                                                        | The whole namespace is one block, overwritten each turn, keeping only the latest turn | core-quest's `changes` |
| Record level    | Write one record per turn, with the key being the turn ID and the value carrying `__turnId` (or `turnId`) | One block per turn, and the history can be reviewed                                   | dice-check's `checks`  |

When rendering, keys that start with `__` do not go into the block's `state`.

When a recovery retry happens, the kernel (`packages/runtime/src/commit/plugin-message-turn.ts`) rewrites the `__turnId` that points to this execution to the source turn being recovered. This way, the card belongs to the content of the recovered segment.

### Form Submission Flow

A form needs a turn ID and an interaction submission handler. If either is missing, the UI asks the player to reopen the session and retry, and keeps the entered values. It does not send the field JSON as a player message or mark the form submitted.

```
Player fills in the form → clicks the submit button
  → submitInteraction():
    1. POST /api/actions (`submit_interaction`): in one operation, the server
       saves the submission, fills in narrativeTemplate and starts the follow-up turn
    2. SSE `interaction.submitted`: the form is marked as submitted; unless the interaction
       declares `submitBehavior.echoFilledNarrative: false`, the natural-language text is echoed
    3. On the same stream, the follow-up turns are handled by the relevant plugin, which reads
       `player.lastFormValues` and completes its business writes
```

### Action Guide Interaction

```
The guide analyzes the narrative → `generate-guide` writes to `plugin_data[message]`
  → `ui.message` renders a situation recap, the current decision, and 3–4 short lines
    (stage mode also shows them through `stage.choices@1`)
  → the player clicks a suggestion and it goes to the pending-send area
  → InputBar sends the pending draft and typed input together
```

## Stage Mode (Stage View)

Stage mode is a visual-novel style screen: a scene background, character portraits, and a dialogue box whose text appears one character at a time.

It is the fourth way to present a session, `viewMode: "stage"`. It sits next to `parsed` / `detailed` / `raw`, and you switch to it in the `GameViewHeader` at the top. When you enter the stage, the three parts of the message area (`ChatMessages`, `PendingDraftsBar` and `MessageComposer`) are all replaced by a full-screen stage. `GameViewHeader` stays.

- **When it renders**: `viewMode === "stage" && (session.phase === "playing" || hasSubmittedForm(...))`. The character creation form is still completed in the original message stream. Once it is submitted, the stage opens right away, and a "Generating" status is shown until the first part of the narrative arrives.
- **Initial value**: a world package can set `defaultViewMode: stage` at the top level of `world.yaml` (it goes into `WorldRecord.metadata.defaultViewMode`). Then the session opens in stage mode the **first time** it is mounted. After the player switches the view in the header, the player's choice wins. This choice is not saved. See [world-data.md](./world-data.md#world-package).

### Layers and Data Sources

The stage has five layers. All are absolutely positioned, and their `z-index` values are set in tiers. The DOM order is Backdrop → Sprites → Hud → Dialog → Choices, and all of them sit inside one bounded `relative` container.

The stage reads the server's `ui.slot@1` projection. Each provider builds the generic slot values from its own data, domain events and the World Model. The front end does not assemble the stage from plugin namespaces on its own.

| Layer        | Data source                                                       | Front-end use                                                                                                   |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Backdrop** | `stage.backdrop@1`                                                | Shows the background, the scene name and the status; falls back to the world's visuals when there is no picture |
| **Sprites**  | `stage.cast@1`, with `character.visual@1` indexed by character ID | Position, highlight, portraits, and a placeholder when there is no picture                                      |
| **Hud**      | `stage.backdrop@1`                                                | Shows the name, the variant and the source status                                                               |
| **Dialog**   | The latest story text and `stage.dialogue@1`                      | Typing, paragraph splitting and per-paragraph speaker names                                                     |
| **Choices**  | `stage.choices@1` and the pending interaction choice block        | Situation recap, decision question, options (`.ui-choice`) and free text input                                  |

**Switching between typing and the decision panel.**

- "Streaming" follows the kernel's convention: there is no streaming boolean. The condition is `executing` together with a story message ID that starts with `stream_`.
- New narrative is shown character by character by `StageDialog`, and each paragraph stops and waits for the player to click. The last paragraph also pauses once, waiting for a closing click. Auto-play moves on by itself according to the pause time. An empty paragraph at the end of the text does not produce an empty pause.
- Narrative text is separate from the “Continue the dialogue” button so screen readers can read it. Live announcements wait until typing finishes for the paragraph. Tab focuses the advance button; Enter or Space continues.
- When typing catches up with the end of the stream, it does not jump to the decision panel automatically.
- After the text has been read, and the turn execution has ended, the same spot is replaced by the unified decision panel. It shows, in order: the scene, a "Current context" summary, the "Decision" question, grouped options, and an inline free text input.
- Right after submitting, the whole old decision panel is hidden, including areas added by plugins. While the new narrative is coming, "Generating" is shown. Narrative that was already read is not replayed.
- When a session is restored, or when you switch into the stage from another view, the latest narrative that already existed before mounting counts as read, so it is not typed out again.
- `stage.choices@1.recap` is optional. When omitted or empty, the panel omits “Current context” and does not extract a summary from the story. If `decision` is omitted, the scene or a generic question guides free input. Reading narration and submitting free input still work without a suggestions provider.
- Omitting `turnId` declares unscoped choices. Choices with a `turnId` appear only when it matches the current story turn; they stay hidden when that turn is unknown. A committed retry can resolve to the source story through the turn resolver. Providers should set `turnId` on choices that expire with the turn, without relying on the framework to infer old data.

**Previews and caching of slots.**

- While an execution is in progress, stage slots can receive preview events. After submission, the server recalculates them and caches the result. When the session is restored, the submitted slots are read again.
- `watch` listens only to the provider's own namespaces. A preview is discarded when it fails or is cancelled. Private plugin data is never handed to the stage directly.
- The server's slot cache keeps up to 256 sessions, in least-recently-used order. A session that is handling a request, queuing a projection or dispatching an event is never evicted. During concurrent work the cache may briefly go over the limit; idle entries are reclaimed once the work finishes.
- A read gets its result before the session state is released. So a cache eviction cannot make a projection that already succeeded return an empty result.

**Portrait highlight.** Each actor in `stage.cast@1` can have an optional `active` flag. As soon as one actor explicitly sets it, each one is shown with its own boolean. When all of them are left out, the first actor who has not left the scene is highlighted by default.

**Speaker name tags.**

- The name tag reads `paragraphSpeakers` from `stage.dialogue@1`. Each entry is a display-name string or `null` (narration), not a character ID or an object. The provider converts its own data into this shape. See [Stage slot values](#stage-slot-values).
- Live events of the same turn can be previewed first. An old committed mapping is not reused during the streaming phase of a retry of the same turn.
- The typewriter and the speaker check share `splitStageParagraphs`. CRLF is turned into LF, and three or more line breaks count as one blank line separator. After the text ends, the number of paragraphs must match the mapping.
- A character name tag is not shown for narration, for an unknown speaker, for an old message with no mapping, or when the turn does not match. An actor's focus does not take part in speaker attribution.

**Size and portraits.**

- On narrow screens the decision panel takes up to 60% of the area below the stage. On wide screens it takes 65%. It always stays inside the stage.
- The recap is folded by default. Click "Current context" to expand it. The recap, the question and the options share one scrollable content area. The free text input is always visible.
- Portraits fade out at the bottom. On narrow screens the position is raised so the face shows above the decision panel. On wide screens the original position height is kept.
- When there is a character picture, no name badge is layered on top. When there is no picture, the name placeholder is kept.

### Background Fallback Chain (`resolveBackdrop`)

The input is the value of a `stage.backdrop@1` slot, which matches `stageBackdropSchema`. `label` is used only for the status text and does not affect the fallback.

| Tier       | When it triggers                           | What it shows                                                                          |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `scene`    | The slot `ref` is a `MediaRef`             | Renders the scene picture (a 600ms crossfade when the picture changes)                 |
| `hero`     | The slot is missing, or has no valid `ref` | The world's header image (`worldVisual().image`, which is the `cover` in `world.yaml`) |
| `gradient` | A theoretical last fallback                | The world's accent gradient (the selector does not currently return it)                |

### History Drawer and Form Modal

- **History drawer**: the History button on the Hud opens a Radix `Dialog`. Inside is the full `<ChatMessages viewMode="parsed">`, wrapped in `flex h-[80vh] flex-col`. So you can still look back and scroll through all the parsed messages while in the stage.
- **Form modal**: the stage dialog takes only options and free text. So when a **form-type** interaction block that has not been submitted yet appears in the messages (`extractPendingFormMessages`), the stage opens a `Dialog` and uses `MessageBlockRenderer` to let the player fill it in. It closes automatically after submission.

Implementation: `apps/web/src/components/session/stage/` (`StageView.tsx` does the assembly. The others are `Stage{Backdrop,Sprites,Hud,Dialog,Choices}.tsx`, `stage-selectors.ts` and `use-typewriter.ts`).

## Component Catalogue

The component catalogue is on its own page: [ui-components.md](./ui-components.md). There are currently 50 components. The `covelRegistry` exported by `apps/web/src/lib/catalog.tsx` is the authority.

## Data Flow

### Right-Panel Data Flow

```
plugin local tool / builtin tool / function handler writes plugin_data
  → store write
  → eventBus emits plugin-data.changed
  → pushed to the front end over SSE
  → pluginData store updates
  → json-render Renderer re-renders automatically
```

### Message Area Data Flow

```
Turn runs → each Runtime runs behind the stage barrier and the DAG inside each stage
  → SSE event stream:
    narrative.delta → streamed narrative is appended
    narrative.completed → the full narrative message
    interaction.requested → interaction block (form / choice)
    execution.started/completed → execution step status
    plugin-data.changed → plugin data update
  → chat-messages renders the turn messages
  → the `plugin_message` branch of the same component renders `ui.message`
```

## Extension Guide (Third-Party Plugins)

None of the three steps below requires changing framework code.

To add a right-side panel:

1. Add `./ui/my-panel.json` under `contributes.ui.right` in `PLUGIN.md`.
2. Create `ui/my-panel.json`, and write a json-render spec with the components in the catalog.
3. Write to `plugin_data` in a local tool, a builtin tool or a function handler.
4. The framework discovers the panel automatically and generates the tab. After that, whenever the plugin data changes, the panel updates with it.

To add a plugin message surface:

1. Add `./ui/my-block.json` under `contributes.ui.message` in `PLUGIN.md`.
2. Create `ui/my-block.json`.
3. Write to `plugin_data[pluginId][message]` in a runtime or a tool.
4. The `plugin_message` branch of `chat-messages.tsx` discovers the spec automatically and renders it.

To add an interaction block bound to a turn:

1. Write `interaction` in a runtime's output or a tool's return value.
2. The session kernel normalizes it into an `interaction.request`.
3. `chat-messages.tsx` renders the form, choice or confirmation UI through `messageToSpec()`.

### Gameplay Completion and Reading Order

**Reading order.**

- Within one turn, story messages come before the plugin message surfaces. This holds even when a plugin message surface arrives first during streaming or data recovery.
- The message order is decided by which turn a message belongs to, not by client timestamps.

**Failures must be visible.**

- After the task chip is collapsed, an execution failure is still visible, along with the affected runtime and its original retry action.
- A turn that only partly completed must not look like it finished cleanly.

**Sending.**

- The input box can submit only the queued choices, without typing anything.
- The main send button and the choice bar both send the queued actions together with the typed text.
- When an interaction RPC is rejected, the form stays editable. It never falls back to sending the form fields as an unvalidated story message.

**Other.**

- The panel-size callback uses the size it is given. It does not query constraints actively while the panel is registering a change.
- Body text uses the current theme's tokens in both light and dark modes.

## Plugin-Provided Components and Stage Mounting

When the components in the catalog are not enough, a plugin can bring its own HTML. In the JSON spec, `webview` is used instead of `view`, and only one of the two can be written:

```json
{ "webview": { "entry": "./widget.html", "height": 280 } }
```

- **What the component can do.** Through the message bridge it receives the current style scheme (`theme` and the `--covel-*` CSS variables), and it can call actions such as `emitEvent` and `draftMessage`.
- **Enlarging.** Every plugin panel in the right-side panel can be "enlarged" to show in a large dialog.
- **Showing on the stage.** A `ui.right` spec can declare `surfaces: ["panel", "stage"]`. When it is not written, it shows only in the right-side panel.
- **Player confirmation and loading failures.** A stage plugin panel’s `sendMessage` fills the input for the player to edit and send. The stage reuses the session’s loaded panel definitions. If loading fails, it shows a message and Retry while the player can still use the input.
- **Isolation.** The HTML sits in a sandboxed iframe with two layers of opaque origin:
  - The outer layer is the static document `/plugin-frame.html` in the web build. It is loaded by URL, so it has its own CSP and does not inherit the main page's policy (the main page does not allow inline scripts). Its CSP stops the plugin document from navigating itself to a network address, and the port is handed over only once.
  - The inner layer is the plugin's HTML. It keeps inline scripts and the `window.covel` data / action bridge. The structure of the component code and of the business state belongs to the plugin.

For the policies of both layers and the validation of the bridge, see [security.md](../internals/security.md#plugin-html). For the full protocol, resource limits and examples, see the [plugin extension contract](./plugin-extensions.md#custom-components-and-mounting).

## Kernel UI Slots

Kernel UI slots are a few fixed positions on the screen, such as the stage background, the characters on stage and the status summary. A plugin does not draw these positions directly. Instead, it provides data, and the framework draws them.

**How to provide one.** A plugin declares a provider for `ui.slot@1` in `contributes.extensions`, and registers a handler in its server `entry`. `slot` chooses which slot to fill:

- `stage.backdrop@1`
- `stage.cast@1`
- `stage.dialogue@1`
- `stage.choices@1`
- `character.visual@1`
- `session.summary@1`
- `stage.music@1`

**How several providers combine.**

- Providers run in the order they declare, and then in the order of plugin ID / provider ID.
- A handler receives `{ slot, previous, events }`, and it can use `ctx.pluginData` within its own scope and the kernel's `ctx.world` view.
- The host validates each provider's output against the slot's model.
- A failed provider is skipped. It cannot replace the valid value before it.

**When it is recalculated.**

- `watch` lists the provider's own namespaces. When one of these namespaces has a commit, the projection is invalidated and recalculated, with a 50 ms debounce.
- `preview` lists the validated domain event topics. A provider can give a preview based on these events before the commit.
- A preview is temporary and belongs only to the current turn. It is discarded when the turn completes, fails or is cancelled. It never replaces the committed cache.
- A result that arrives after a terminal event is discarded.

**Character pictures.**

- The character picture provider returns `{ characters: CharacterVisualModel[] }`. This includes art that was imported before the character was created.
- The provider is responsible for normalizing the IDs. The host emits one keyed `character.visual@1` snapshot for each `characterId`.
- The front end looks them up with exactly the same key. It does not guess the plugin namespace or the suffix of an ID.
- The stage, avatars, the portrait gallery and the list of characters on stage all read these slots.

### Stage Slot Values

These are the return values for the four stage slots, defined in `packages/shared/src/extension-points/ui-slot.ts`. Each provider returns the object for its declared `slot`, without bundling the four objects together. Return `previous` when there is no change, or `null` to clear the slot.

The four slot objects, and the actor, `visual` and choice objects below, accept only the listed fields. An invalid output skips that provider and keeps the previous valid value; it does not reject the whole session. `I18nText` is a string or a map from locale to string. `MediaRef` is a reference returned by the [media store](./media-store.md), not a path or a bare URL.

#### `stage.backdrop@1`

Every field is optional. `{}` is also valid.

| Field     | Type                 | Required | Meaning                                                                                                                |
| --------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sceneId` | string               | No       | Scene identifier                                                                                                       |
| `name`    | string               | No       | Scene name shown in the HUD                                                                                            |
| `ref`     | MediaRef             | No       | Current background image; when absent, use the [background fallback chain](#background-fallback-chain-resolvebackdrop) |
| `variant` | `"day"` or `"night"` | No       | Day/night marker. The HUD shows a moon only for `night`, otherwise a sun. Other enum values are not accepted           |
| `label`   | I18nText             | No       | Extra status text in the HUD; does not affect background fallback                                                      |
| `preload` | MediaRef[]           | No       | Images to preload; the schema has no item limit, and the client skips references whose MIME type is not `image/*`      |

#### `stage.cast@1`

The value is `{ actors, retainWhenEmpty }`. Both fields are required.

| Field             | Type                                   | Required | Meaning                                                                                                                        |
| ----------------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `actors`          | Array of the objects below, at most 64 | Yes      | Actors currently on stage; an empty array is valid                                                                             |
| `retainWhenEmpty` | boolean                                | Yes      | When `actors` is empty, `true` keeps the previous portraits without highlights; `false` clears them. The schema has no default |

Each actor:

| Field         | Type                                                                          | Required | Meaning                                                                                              |
| ------------- | ----------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `characterId` | Non-empty string                                                              | Yes      | Character ID; uses the same ID to read `character.visual@1`                                          |
| `displayName` | Non-empty string                                                              | Yes      | Display name                                                                                         |
| `type`        | string                                                                        | No       | Character type                                                                                       |
| `description` | string                                                                        | No       | Character description                                                                                |
| `active`      | boolean                                                                       | No       | Whether to highlight this actor; if all actors omit it, highlight the first actor who is not exiting |
| `exiting`     | boolean                                                                       | No       | Whether the actor is exiting                                                                         |
| `visual`      | `{ variantId?: string, outfit?: string, expression?: string, pose?: string }` | No       | Requested portrait variant; all four fields are optional                                             |
| `position`    | `left` / `center-left` / `center` / `center-right` / `right`                  | No       | Requested position                                                                                   |
| `transition`  | `none` / `fade` / `slide-left` / `slide-right` / `dissolve`                   | No       | Portrait transition; the client uses `fade` when omitted                                             |

#### `stage.dialogue@1`

| Field               | Type                             | Required | Meaning                                                                                                                                 |
| ------------------- | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `turnId`            | string                           | No       | The story turn being attributed. Set it when attributing the current text; name tags appear only when it matches the current story turn |
| `paragraphSpeakers` | `(string \| null)[]`, at most 80 | Yes      | Display name for each paragraph; `null` means narration or no attribution                                                               |

For example, `{"turnId":"<story-turn-id>","paragraphSpeakers":["Mio",null,"Rin"]}` attributes three paragraphs to Mio, narration and Rin. Set `turnId` to the current story's turn ID. The text is split on blank lines after CRLF is converted to LF and three or more line breaks are reduced to two. When the text ends, the paragraph count must equal the array length; otherwise no name tags from the mapping are shown. A live mapping must also come from the current turn's preview. A committed mapping from before a retry cannot be reused.

#### `stage.choices@1`

| Field      | Type                                   | Required | Meaning                                                                                       |
| ---------- | -------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `turnId`   | string                                 | No       | When set, the choices apply only to the matching story turn; omitting it leaves them unscoped |
| `scene`    | I18nText                               | No       | Scene text in the decision panel                                                              |
| `recap`    | I18nText                               | No       | "Current context" recap; hidden when omitted or empty                                         |
| `decision` | I18nText                               | No       | The question to decide now                                                                    |
| `choices`  | Array of the objects below, at most 64 | Yes      | Choices; an empty array is valid                                                              |

Each choice:

| Field   | Type             | Required | Meaning                                                                                       |
| ------- | ---------------- | -------- | --------------------------------------------------------------------------------------------- |
| `id`    | Non-empty string | Yes      | Choice identifier                                                                             |
| `text`  | string           | Yes      | Text displayed and used for the player's message; the client trims it and skips blank choices |
| `label` | I18nText         | No       | Extra description; does not replace `text`                                                    |

See [Stage mode](#stage-mode-stage-view) for turn matching, the default decision question and free input.

### Stage Music

`stage.music@1` stores "what music should be playing behind the session right now":

```ts
{ trackId?, title?, ref?, loop?, volume?, fadeMs? }
```

It is a state, not a command.

- The client plays `ref` (an `audio/*` media reference).
- When `trackId` changes, the track changes with a crossfade.
- When the value has no `ref`, it stays silent.
- So after a page refresh, a session restore or a fork, you hear the same music. When a provider gives the same track again, it is not replayed from the beginning.

Details:

- `loop` defaults to true. `volume` (0–1) is the volume the author set for this track. The player's own volume and mute switch apply on top of it.
- A provider with nothing to say returns `previous`. This lets several plugins share the slot in declared order: one plays the world's own tracks, and another fills in a generated track where the world has none.
- Playback is handled by the client. When another sound is playing on the page (for example, a narration line), it lowers the music. It pauses when the page is hidden. When the browser does not allow automatic sound, it waits for the first click or key press before starting.
- The player's switches are in the session header and in "Settings → General" (`audio.musicEnabled`, `audio.musicVolume`).

The built-in `soundtrack` plugin fills this slot with the world's own tracks. It records the mood (`music.cue`) and the scene (`scene.set`), and it chooses a track when the slot is projected. See [world-data.md](./world-data.md#background-music).

### Session Summary

`session.summary@1` holds what a plugin wants the player to see at a glance: the current goal, the time, and what the player is carrying.

The client shows it where the current layout keeps its status: below the text-tab panel, or on the scene HUD. So a plugin declares it once and does not need to know what the layout is.

**Shape of the value.** `{ entries: SessionSummaryEntry[] }`, up to 16 entries. Each has an `id`, a `label` (`I18nText`) and a `kind`:

| `kind`  | Fields                                | Drawn as                                                                          |
| ------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `text`  | `value` (`I18nText`), `tone?`         | A label and a line of text                                                        |
| `meter` | `value`, `max`, `min?` (0), `tone?`   | A label, a gauge and `value / max`                                                |
| `list`  | `items` (`I18nText[]`, ≤24), `total?` | A label and a row of small tags; when `total` is larger, `+N` is shown at the end |

`tone` is `info`, `success`, `warning` or `danger`.

**Rules for writing it.**

- Providers form a chain: each provider returns the entries that came before it, plus its own. `appendSummaryEntries(previous, entries)` from `@covel/plugin-handlers-utils` does this.
- Prefix each entry ID with the plugin's own name, for example `inventory.items`. A later entry with the same `id` replaces the earlier one.
- Keep it short: one to three entries per plugin. Leave the details to the plugin's own panel.

```yaml
contributes:
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 20 # lower runs first and shows first
      watch:
        - quests # own namespaces whose commits refresh the summary
```

```js
import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";

export default function (covel) {
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      const quests = await ctx.pluginData.list("quests");
      return appendSummaryEntries(previous, [
        {
          id: "quest.current",
          kind: "text",
          // English here; `locales/<locale>.yaml` translates it under `messages`.
          label: labelText(ctx, "Objective"),
          value: quests[0]?.value?.name ?? "",
        },
      ]);
    },
  });
}
```

The built-in `world-time` (current time), `core-quest` (the next unfinished objective and its progress) and `inventory` (carried items) all provide entries this way.

**Several rules on data ownership.**

- A panel's data binding and the `pluginId` field of an action can point only to the plugin that owns the panel. The loader rejects targets that point to another plugin or that are computed at runtime.
- To share data between plugins, use a kernel slot or the World Model.
- A component that needs kernel data before its own namespace has records can bind a session source with `dataSource.source`. A component that reads session context itself must set `alwaysRender: true`.
- Panels in past messages render from their saved `stateOverride`. They do not subscribe to live namespaces, tasks or the whole session context. A collapsed past card is not mounted.
- Live plugin namespaces have only one source of truth on the front end: the external plugin-data store. The session reducer keeps only the `message` namespace needed to build snapshots of past message cards, along with the derived persistent task execution steps. Updates to unrelated namespaces do not replace the session context's values.

### Suspended Resume Panel

After an agent runtime calls `suspend`, a badge appears on the session toolbar. Clicking it opens the "Suspended executions" dialog (`suspensions-panel.tsx`).

Each card uses `reason` as its title, and it picks the answer control from `resumeSchema` (`suspension-input.ts`):

| `resumeSchema`                                                      | Control                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `boolean`                                                           | Yes / No buttons                                              |
| `enum`, or `const` in `oneOf`                                       | Option buttons                                                |
| `string`                                                            | Text box                                                      |
| An object / number schema that the dimension value editor can cover | A form (reusing `DimensionValueEditor`)                       |
| No schema, or no control can cover it                               | A raw JSON text box inside the "Advanced" collapsible section |

### Loading Older Messages and Execution Status

- When loading an earlier page while scrolling up fails, a translated failure message and a "Retry" button appear at the top of the message area. The message disappears after a successful load.
- When the execution timeline meets a runtime status that the client does not recognize, it shows a neutral "Unknown status" label and logs it once to the console. It is never drawn as "completed".
