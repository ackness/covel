# Add UI to a Plugin

This page explains how to make a plugin show content in the game: a panel in the sidebar, a block inside the story text, a set of choices, a form, and a fully custom interface. It is written for an author who already has a plugin that runs and now wants players to see it.

By the end, you will have changed the "tavern rumors" panel from [Your First Plugin](./first-plugin.md) into your own design, and added a block of story-text content to it. Most interfaces need only JSON. You do not need to write any front-end code.

## Before you start

- Finish [Your First Plugin](./first-plugin.md), so that you have `~/.covel/plugins/tavern-rumors/`.
- Run the commands below from the root of the Covel repository.

Write the text in interface files in English. Put the Chinese text under `messages` in `locales/zh.yaml`. Each step on this page includes its translation.

## Choose the right place first

A plugin's content can appear in a few fixed places. First choose the place that fits what you want to do, then read the matching section.

| What you want to do                                                                          | What to use                                                       | Where it shows                                                        | What to write                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| Complete data the player can look through at any time (codex, inventory, relationship graph) | Side panel `ui.right`                                             | A tab in the right-hand panel                                         | One JSON file                      |
| Content that appears after a certain turn (suggestions, summaries, hints)                    | Story-text block `ui.message`                                     | In the story text, under that turn                                    | One JSON file                      |
| Choices for the player to pick from                                                          | `ChoiceList` / `Choice` components                                | In the story text; the decision area in stage view                    | JSON, or one tool call             |
| A form that must be answered before the game continues                                       | `create-form` tool                                                | In the story text; the input box is locked until it is answered       | One tool call                      |
| A status the player should see at a glance (goals, time, inventory)                          | Status summary `session.summary@1`                                | Below the panel tab, or as a status bar on the scene picture          | A dozen or so lines of code        |
| Scene pictures, portraits, background music                                                  | Picture slots the framework reserves                              | Stage view, scene background, avatars                                 | A piece of code that supplies data |
| Interfaces the ready-made components cannot draw (a map, a board, a mini-game)               | Your own HTML file `webview`                                      | The right-hand panel; it can also attach to the stage's decision area | One HTML file                      |
| The story the player reads                                                                   | Not an interface. Output of a runtime with `io.visibility: story` | Story text                                                            | A prompt                           |

The order of choice is: use a ready-made component if it is enough. If it is not, write HTML. If nothing fits, propose that the framework add a new place.

> [!NOTE]
> This page calls the ready-made pieces the framework provides "components". Their names and parameters are in the [UI components reference](../reference/ui-components.md). All fields of a panel file are in the [Panel reference](../reference/ui-panels.md). This page explains how to use them and does not repeat those two tables.

## 1. Read the generated panel

Open `runtimes/note/ui/panel.json`. It has two parts. The top few lines say which panel this is and which data it reads. The `view` below says what it looks like.

```json
{
  "id": "tavern-rumors-notes",
  "group": "tavern-rumors",
  "groupLabel": "tavern-rumors",
  "groupOrder": 800,
  "label": "Plugin Notes",
  "shortLabel": "Notes",
  "icon": "notebook-pen",
  "dataSource": { "namespace": "notes" },
  "alwaysRender": true,
  "emptyState": { "message": "No plugin notes yet. ..." },
  "view": { "component": "Stack", "children": ["..."] }
}
```

| Field                  | Meaning                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | The panel's name. It must be unique within this plugin.                                                                                                                                           |
| `label`                | The full name on the tab.                                                                                                                                                                         |
| `shortLabel`           | The short name shown when the tab is very narrow. Write both, so that the panel is easy to recognize in every layout.                                                                             |
| `icon`                 | The tab's icon. Choose from the icon names the framework allows. See the [UI components reference](../reference/ui-components.md#display).                                                        |
| `group` / `groupLabel` | Use these to put several panels under one tab. Panels with the same `group` share a tab, and you switch between them with sub-tabs. You can leave them out when there is only one panel.          |
| `groupOrder`           | The order of the tab. A smaller number comes first. The default is 500.                                                                                                                           |
| `dataSource.namespace` | Which data namespace of the plugin this panel reads. Here it is `notes`.                                                                                                                          |
| `emptyState.message`   | One sentence shown when the data namespace has no content yet.                                                                                                                                    |
| `alwaysRender`         | When set to `true`, the `view` is drawn even when there is no data. A panel with an "Add" button needs this. Without it, an empty panel shows only the message, and the button cannot be clicked. |
| `view`                 | The interface itself: a tree of components.                                                                                                                                                       |

The panel file must be registered in `PLUGIN.md`. The scaffold has already written this for you:

```yaml
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
```

### How data becomes an interface

A plugin's data namespace is a set of key-to-value records. Once the panel has it, it can read it in two ways:

- By key: `{ "$state": "/some-key" }`.
- By list: the framework also prepares an `/entries` array, where each item is `{ key, value }`. Use `repeat` to repeat a component once for each item, and inside it use `{ "$item": "value/title" }` to read a field of that item.

The lower half of the scaffolded panel lists the records this way:

```json
{
  "component": "Stack",
  "repeat": { "statePath": "/entries", "key": "key" },
  "children": [
    { "component": "Text", "props": { "content": { "$item": "value/title" } } }
  ]
}
```

After a runtime writes data and commits it, the panel redraws itself. You do not need to write any refresh code. For more ways to read data, see the [UI components reference](../reference/ui-components.md#data-bindings-cheat-sheet).

## 2. Change the panel into your own

Replace the whole of `runtimes/note/ui/panel.json` with the content below. It does only three things: an "Add note" button, a list of rumors, and an "Ask about this" button under each rumor.

```json
{
  "id": "tavern-rumors-notes",
  "label": "Rumors",
  "shortLabel": "Rumors",
  "icon": "notebook-pen",
  "dataSource": { "namespace": "notes" },
  "alwaysRender": true,
  "emptyState": { "message": "No rumors yet." },
  "view": {
    "component": "Stack",
    "props": { "gap": "sm" },
    "children": [
      {
        "component": "Button",
        "props": { "label": "Add note", "variant": "primary", "size": "md" },
        "on": {
          "click": {
            "action": "invokeRuntime",
            "params": {
              "runtimeId": "tavern-rumors/note",
              "payload": { "title": "Manual note", "text": "Written by hand." }
            }
          }
        }
      },
      {
        "component": "Card",
        "props": { "variant": "subtle" },
        "repeat": { "statePath": "/entries", "key": "key" },
        "children": [
          {
            "component": "Stack",
            "props": { "gap": "xs" },
            "children": [
              {
                "component": "Text",
                "props": {
                  "content": { "$item": "value/title" },
                  "weight": "bold",
                  "size": "sm"
                }
              },
              {
                "component": "Text",
                "props": { "content": { "$item": "value/text" }, "size": "sm" }
              },
              {
                "component": "Button",
                "props": {
                  "label": "Ask about this",
                  "variant": "ghost",
                  "size": "compact"
                },
                "on": {
                  "click": {
                    "action": "draftMessage",
                    "params": { "text": { "$item": "value/title" } }
                  }
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

You changed the English text on the screen, so the translations must change too. Open `locales/zh.yaml` and change the `messages` section to:

```yaml
messages:
  Rumors: 传闻
  No rumors yet.: 还没有传闻。
  Add note: 添加记录
  Ask about this: 追问这条
```

Then validate:

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

If you change the panel but forget to change the translation, validation fails. It lists each translation whose English text no longer exists:

```text
✗ /Users/you/.covel/plugins/tavern-rumors: locale files
  - locales/zh.yaml: messages: "Plugin Notes" is not a text of this plugin's UI or code; the English text changed or was removed, so this translation is ignored
```

To see the result in the game, keep `pnpm dev` running. Save the file, and the plugin reloads by itself. Refresh the page. The tab's name becomes "Rumors". Clicking "Add note" adds one more entry. Clicking "Ask about this" puts that rumor's title into the draft area above the input box.

> [!IMPORTANT]
> Validation also checks the structure of the interface files: component names, that exactly one of `view` and `webview` is set, the form of `repeat.statePath`, the field names in `$item`, `specVersion`, and that the spec refers only to this plugin's data. The game uses the same rules when it shows a panel, so a panel that passes validation is not dropped for its format. If you write `Card` as `Kard`, validation fails and names the file and the place in it, for example `./runtimes/note/ui/panel.json: view.children[0].component: unknown component Kard`. Validation also checks `FilterContainer` array bindings, row templates and `$map` shapes; other component props and action names are outside this check. If a panel does not appear, open the browser's developer tools and look at the console. In development mode, the framework prints each dropped panel and the specific reason.

For search or category tabs, put each record’s subtree in `FilterContainer.itemTemplate` under `props`; it can still contain buttons and badges. Use `$map` to show translatable labels for enum keys. See [row templates](../reference/ui-components.md#filtercontainer-row-templates) and [value-label mapping](../reference/ui-components.md#value-label-mapping).

## 3. Make buttons do things

Inside a component's `on.click`, write an action name and its parameters. The previous step used two of them. All available actions:

| Action               | Effect                                                                                                                     | Story-text block | Side panel    | Stage decision area |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- | ------------------- |
| `draftMessage`       | Puts a sentence into the draft area. The player can add more and send everything together.                                 | Available        | Available     | Not available       |
| `sendMessage`        | In story blocks, sends immediately; on stage, fills the input for the player to send.                                      | Available        | Not available | Available           |
| `invokeRuntime`      | Runs a manually triggered runtime. Several pieces of data it writes either all take effect or none do.                     | Available        | Available     | Available           |
| `invokePluginAction` | Calls an instant action the plugin registered: it runs and writes at once, without starting a new turn or calling a model. | Available        | Available     | Available           |
| `invokeCommand`      | Runs a player command declared in the manifest (a command such as `/bag`).                                                 | Available        | Available     | Available           |
| `emitEvent`          | Emits an event this plugin declared. Runtimes that subscribe to it run in the background.                                  | Available        | Available     | Available           |

A few rules:

- `invokeRuntime`, `invokePluginAction`, `invokeCommand`, and `emitEvent` can point only at your own plugin. They cannot write to another plugin.
- `invokeRuntime` names one runtime, waits for it to finish, and gets its result. `emitEvent` only says that something happened. The click returns at once, and you do not get the subscribers' results. Use the first one when you need to see the result right away.
- The event name in `emitEvent` must be listed in `contributes.events` of your own `PLUGIN.md`. An event meant only for the interface can be written with `advertise: false`, so that the model that writes the story does not see it.
- The first time a community plugin emits an event, the player must authorize two things: emitting that event, and running the community runtime that subscribes to it.
- A runtime that subscribes to an event is a background job. It does not run when there is no usable model key for the session.

To make "go to the docks" a player action that the story then picks up, use `draftMessage` or `sendMessage`. To change data directly, use `invokeRuntime` or `invokePluginAction`.

Choices the player makes are remembered. When content that went into the draft area through `draftMessage` is sent, a line "You chose: ..." appears under the block it came from. You do not need to write anything for this.

## 4. Put a block in the story text

The side panel is always there. A story-text block follows the turns instead. It appears under the story of one turn and stays in the history afterward. It suits a short summary of "what happened in this turn". Leave the details to the side panel.

Below, you add one block to "tavern rumors". After each turn, it shows how many rumors have been heard so far in the story text. Three things are needed.

**An interface file.** Create `runtimes/recap/ui/rumor-block.json`:

```json
{
  "id": "tavern-rumors-recap",
  "dataSource": { "namespace": "message" },
  "view": {
    "component": "Row",
    "props": { "gap": "sm", "align": "center" },
    "children": [
      {
        "component": "Text",
        "props": { "content": "Rumors so far", "size": "sm" }
      },
      {
        "component": "Badge",
        "props": { "label": { "$state": "/count" }, "color": "blue" }
      }
    ]
  }
}
```

**Register it in `PLUGIN.md`.** Add a `message` entry next to `right`:

```yaml
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
    message:
      - ./runtimes/recap/ui/rumor-block.json
```

**A runtime that writes data each turn.** Create `runtimes/recap/RUNTIME.md`:

```yaml
---
description: Counts the rumors after each turn and shows the total in the story.
schedule:
  stage: post-turn
  after:
    - tavern-rumors/analyst
function: {}
---
```

And `runtimes/recap/handler.js`:

```js
/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function recapHandler(ctx) {
  const notes = await ctx.pluginData.list("notes");
  return {
    outcome: "success",
    effects: {
      pluginData: [
        {
          namespace: "message",
          key: ctx.turnId,
          value: { __turnId: ctx.turnId, count: notes.length },
        },
      ],
    },
  };
}
```

Then add the translations (`locales/zh.yaml`):

```yaml
runtimes/recap/RUNTIME.md:
  description: 每个回合结束后数一遍传闻，把总数显示在正文里。
messages:
  Rumors so far: 目前听到的传闻
```

After validation passes, a story-text block has three rules you need to know:

1. **The data namespace must be called `message`.** A story-text block reads only this one namespace.
2. **Use `__turnId` to say which turn the data belongs to.** The code above writes one record per turn. The key is the turn's ID, and the value includes `__turnId`. That way each turn gets its own block, and you can look back at them in the history. Another way is to write `__turnId` as a key directly in the `message` namespace. Then the whole namespace is one block, which is replaced every turn, so only the most recent turn is kept. Keys that start with `__` do not appear in the interface.
3. **The first write cannot depend only on a button in this block.** When the data namespace has no content, this block does not appear at all, so the button in it cannot be clicked. The write that makes it appear for the first time must come from an automatically running runtime (like `recap` above), from another runtime, or from data that the world package provides.

You can check offline that this runtime writes correctly. Add an entry to `cases` in `tests/runtime-cases.json`:

```json
{
  "name": "recap-writes-message",
  "runtimeId": "tavern-rumors/recap",
  "expect": {
    "runtimeResults": [
      { "runtimeId": "tavern-rumors/recap", "status": "success" }
    ],
    "pluginData": [{ "namespace": "message", "field": "count" }]
  }
}
```

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

In the output, all three cases show `"status": "passed"`.

> [!NOTE]
> In the default interface layout, read-only blocks that appear in each turn (such as hints and status changes) are merged into one line, "Turn updates · N", which expands when you open it. Forms, choices, and warnings are never collapsed.

## 5. Give the player choices

There is only one correct way to offer the player choices: put several `Choice` components inside a `ChoiceList`.

```json
{
  "component": "ChoiceList",
  "children": [
    {
      "component": "Choice",
      "props": {
        "title": { "$state": "/prompt1Text" },
        "tag": { "$state": "/prompt1Label" }
      },
      "visible": { "$state": "/prompt1Text" },
      "on": {
        "click": {
          "action": "draftMessage",
          "params": { "text": { "$state": "/prompt1Text" } }
        }
      }
    }
  ]
}
```

Writing it this way means the framework does three things for you:

- The player can press the number keys 1 to 9 to pick the matching option on the screen.
- Each interface style draws options in its own way (labeled cards, numbered lists, key caps). Your options change with the style automatically.
- The echo after a choice is made, and the "You chose:" line, are built in.

> [!WARNING]
> Do not build choices yourself from a `Card` and `Button`. Options built that way do not change with the interface style, and the number keys do not work with them.

The built-in `guide` plugin is a full example: [`plugins/guide/ui/guide-block.json`](../../../plugins/guide/ui/guide-block.json). It has a scene recap and "what you need to decide now" at the top, and a `ChoiceList` in the middle. Each option's `title` is one sentence of action that can be sent as it is. Its `tag` gives the category.

If the choice is a required question the player must answer before the game continues, you do not need to write the interface yourself. Have the agent call the built-in `create-choices` tool, and the framework draws it as the same kind of options. See the [Tools reference](../reference/tools.md#create-choices).

## 6. Ask the player for a form

When the player must fill in several fields before the game can continue (creating a character, a multi-step confirmation), do not write an interface file. Have the runtime send a form instead. After an agent lists `create-form` in `agent.tools.builtin`, it can call it:

```json
{
  "formId": "rumor-source",
  "title": "Who told you this?",
  "fields": [
    { "type": "text", "name": "speaker", "label": "Speaker", "required": true },
    {
      "type": "select",
      "name": "trust",
      "label": "Do you believe it?",
      "options": [
        { "value": "yes", "label": "Yes" },
        { "value": "no", "label": "No" }
      ]
    }
  ],
  "submitLabel": "Record",
  "narrativeTemplate": "{{speaker}} told me. Do I believe it: {{trust}}."
}
```

The field types are `text`, `textarea`, `select`, `checkbox`, and `number`. For all the parameters, see the [Tools reference](../reference/tools.md#create-form).

For model review of a filled narrative, a composed tool can return a preview using the SDK's `fillNarrativeTemplate`, and let the runtime finish after reading the result. See the [Tools reference](../reference/tools.md#create-form) for interaction revision rules.

What happens once the form appears:

- The form shows in the story text. The input box is locked until the player answers.
- When the player submits, the framework fills the entered values into `narrativeTemplate`. That sentence appears in the story text as the player's words, and the next turn starts. Your plugin reads these values in that turn.
- If you do not want this sentence to appear in the story text, write `"submitBehavior": { "echoFilledNarrative": false }` on the form. Then the next turn has no player words, and the plugin reads the answers from the saved form values. This field defaults to `true`.

Validation and errors:

| Situation                                                                  | What the player sees                                                                                                                                                        | API response                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A required field is empty, a number is out of range, or an option is wrong | A short explanation appears under the field with the problem. The cursor moves to the first field with an error. What was already entered is kept. No error banner pops up. | `code: "form_rejected"`, nothing is saved |
| Your own validation function rejects the submission                        | The same as above. If the returned error includes a field name, it shows under that field. If not, it shows above all the fields.                                           | `code: "form_rejected"`                   |
| The same form is submitted a second time                                   | The reason for the rejection is shown, and the first answers are filled back in.                                                                                            | `code: "interaction_already_submitted"`   |

A form can be answered only once. If the player opens the game again in another browser tab or on another device, a form that was already answered shows as answered, with the values it had then.

To add your own validation rules (for example, two fields must not be the same), or to explain why a form is showing again (`notice`), see `validation` and `notice` in the [Tools reference](../reference/tools.md#create-form).

## 7. Status the player should see at a glance

Things like "current goal", "what time it is", and "what the character carries" should not be hidden in a tab. A plugin can supply one to three status lines. Each line is a sentence, a gauge, or a short list. The framework puts them where the current interface style shows status: some styles place them below the panel tabs, and others place them in a status bar on the scene picture. The plugin does not need to know which style is in use.

This takes about a dozen lines of code in the plugin's `entry` module. For the way to write it and a full example, see [Session summary in the panel reference](../reference/ui-panels.md#session-summary). The details still belong in your own side panel. The summary only lets the player glance at the key facts.

In the same way, the framework draws the content below, and the plugin only provides the data:

| Content                         | Slot name            | Notes                                                                                                                                                                                         |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene picture                   | `stage.backdrop@1`   | The stage view and the text view with a scene background read the same data.                                                                                                                  |
| Characters present              | `stage.cast@1`       | Used by the stage view. Who is speaking needs no slot: the stage reads the speakers of the story segments.                                                                                    |
| Choices on the stage            | `stage.choices@1`    | The decision area of the stage view.                                                                                                                                                          |
| Character avatars and portraits | `character.visual@1` | The avatar, the portrait panel, and the stage all read it.                                                                                                                                    |
| Background music                | `stage.music@1`      | The plugin says only "which track should play now". Playback, fading in and out, the player's volume, and the mute switch are all handled by the framework, so the plugin needs no interface. |

For the data format of these slots, see [Kernel UI slots in the panel reference](../reference/ui-panels.md#kernel-ui-slots). The list of slots is fixed. A plugin cannot add its own.

> [!TIP]
> You often do not need to write a plugin for numeric gauges or carried items. A numeric character attribute with a range, or equipment stored as a string array, is shown on the status bar by the framework itself.

## 8. Draw your own interface

Some things, such as a map, a board, or a puzzle mechanism, cannot be drawn with the ready-made components. For these, the panel file does not write a `view`. Instead, it writes a `webview` that points to an HTML file the plugin includes:

```json
{
  "id": "tavern-rumors-board",
  "label": "Rumor board",
  "shortLabel": "Board",
  "icon": "map",
  "alwaysRender": true,
  "dataSource": { "namespace": "notes" },
  "webview": { "entry": "./board.html", "height": 240 }
}
```

You can write only one of `view` and `webview`. `entry` is a path relative to this JSON file. It must be a `.html` file inside the plugin directory, and it can be at most 512 KiB.

The HTML file runs in an isolated frame. The framework gives it a `window.covel` object, which it uses to read data and trigger actions:

```html
<!doctype html>
<meta charset="utf-8" />
<style>
  body {
    margin: 0;
    padding: 12px;
    color: var(--covel-foreground, CanvasText);
    font-family: var(--covel-font-sans, system-ui), system-ui, sans-serif;
  }
</style>
<ul id="list"></ul>
<script>
  window.covel.subscribe(({ data = {}, locked = false }) => {
    const list = document.getElementById("list");
    list.replaceChildren();
    for (const [key, note] of Object.entries(data)) {
      const item = document.createElement("li");
      item.textContent = note.title; // textContent, never innerHTML
      item.onclick = () => {
        if (!locked) window.covel.invoke("draftMessage", { text: note.title });
      };
      list.append(item);
    }
  });
</script>
```

| What you can do                                    | How                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read your own data, and redraw when it changes     | `window.covel.subscribe(({ data, locale, locked, context, uiState, theme }) => …)`                                                                                                    |
| Trigger your own backend logic                     | `window.covel.invoke("invokeRuntime" \| "invokePluginAction" \| "invokeCommand" \| "emitEvent", …)`                                                                                   |
| Pass one sentence to the player                    | In the side panel, use `invoke("draftMessage", { text })`. On the stage, use `invoke("sendMessage", { text })`.                                                                       |
| Remember temporary interface state such as a draft | `invoke("setUiState", { value })`. It is lost when the page is refreshed or when the player leaves the game.                                                                          |
| Change colors with the style the player chose      | Use the group of `--covel-*` CSS variables, for example `color: var(--covel-foreground)`. They update automatically when the player changes style or switches between light and dark. |
| Also appear in the stage view's decision area      | Write `"surfaces": ["panel", "stage"]` in the panel file.                                                                                                                             |

Limits to follow when you write HTML:

- **Everything is in one file.** Write scripts and styles as inline `<script>` and `<style>`. Use `data:` URLs for images. You can use React or Vue, but you must first bundle them into one HTML file with inline scripts.
- **No network access.** You cannot load scripts, styles, fonts, or images from the network. You cannot use `fetch`, submit forms, or navigate away. Talk to the backend only through `window.covel.invoke`.
- **No access to the game page.** The page's local storage, cookies, and APIs are not reachable. Another plugin's data is not reachable either.
- **Give fonts a fallback.** The game's own font files cannot get into this isolated frame. `--covel-font-*` works only when the player has that font installed on their system.
- **Do not send actions while the input is locked.** When `locked` is `true`, the framework rejects any action you send.

If the frame is too small, you do not need to make a separate large version. Each plugin panel in the sidebar has an "Expand panel" button in its top-right corner. Clicking it shows the same panel in a large dialog. There, the `webview` takes up about 72% of the screen height.

For the full protocol (the values in `theme`, what `context` carries on the stage, and the size limit of `uiState`), see [Plugin extension reference](../reference/plugin-extensions.md#custom-components-and-mounting). For how the isolation works, see [Security boundaries](../internals/security.md#plugin-html).

### Example: a clickable map

The repository has a complete, working example: [`tests/third-party/clickable-map`](../../../tests/third-party/clickable-map/README.md). It connects the sections above:

1. Locations and the player's position are stored in the plugin's own data namespace. A world package can preset them.
2. The side panel is a `webview`. It draws the map with SVG, and it redraws when `subscribe` receives data.
3. When the player clicks a location, the interface emits the event `map.location-selected`.
4. A runtime that the plugin itself subscribes to checks whether the move is allowed, and then updates the position. Other plugins can also subscribe to the same event and do their own work.
5. After the data is committed, it is sent back to the interface, and the map redraws.

Puzzles follow the same idea. The clues and progress are stored in a data namespace. Each step is checked with `invokePluginAction` (for immediate feedback) or `invokeRuntime` (when it must take effect together with other data). Content the player must not see, such as the answer, is stored in a data namespace whose name starts with `_hidden.`, and it is compared only on the backend.

## Let the interface follow the style

The player can change the interface style in **Settings → Appearance**. Each style has different colors, fonts, and corner radii. Some styles even have a different structure: whether tabs are icons or text, and whether there is a scene background. You do not need to write a separate interface for each style. Just follow these rules:

- **Say what it means, not what it looks like.** Use component parameters such as `tone` and `variant` to express "warning", "success", or "secondary". Do not write specific colors, fonts, or corner radii into the interface file.
- **Say what the content is, not where it goes.** The style decides where the panel sits and what its tab looks like. You only need to provide good `label`, `shortLabel`, and `icon` values.
- **Do not assume how wide the panel is, or whether the theme is dark or light.** The player can drag the panel's width. Content must be able to wrap and scroll. Images and charts should not depend on a dark background.
- **Color your own interface with `--covel-*` variables.** Do not hard-code colors.

To check this yourself: in **Settings → Appearance → Style**, choose "Panel", "Book", and "Stage" in turn. Each time you switch, look at your panel and the story-text block.

## Current limits

Before you build a more complex interface, know what the framework gives you now. The points below describe the current state. They are not things that can never be done. If you really need one, you can propose that the framework add it.

| Area                        | How it works now                                                                                                | So                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Places it can go            | Story-text blocks, side-panel tabs, and the stage decision area. The status bar accepts only status summaries.  | You cannot place a panel over the scene picture at the moment.                                                          |
| Panel size                  | The player drags the sidebar to set its width. Any panel can be expanded into a large dialog.                   | There is no permanent large central area.                                                                               |
| Turn information            | The interface in the stage decision area can get the current turn and the current choices. A side panel cannot. | A side panel that needs to know "which turn this result belongs to" must store the turn information in its data itself. |
| Interface events            | `emitEvent` hands the event to subscribers, which run in the background, and does not return their results.     | To get a result right away, use `invokeRuntime` or `invokePluginAction`.                                                |
| Content the framework draws | The list of places is fixed, and the data format of each place is fixed.                                        | New content that the framework draws requires a framework change. For content the plugin draws itself, use `webview`.   |

## When something does not work

| Symptom                                                                           | Cause and fix                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation reports a translation as "is not a text of this plugin's UI or code"   | You changed the English text on the screen, but the old sentence is still in `locales/zh.yaml`. Delete the old translation and add the new one.                                                                     |
| Validation reports `cannot read ./…json`                                          | The path registered in `PLUGIN.md` does not match where the file actually is.                                                                                                                                       |
| Validation reports `unknown component`, or mentions `repeat.statePath` or `$item` | This place in the interface file is wrong. The error gives the file and the path of the node. Fix it as the end of the error says. Component names are in the [component catalogue](../reference/ui-components.md). |
| Validation passes, but the panel does not appear in the sidebar                   | This session has not selected or authorized the plugin, or the interface file has a problem that validation does not check. Look at the reason printed in the browser console.                                      |
| The panel appears, but it shows only the empty-state sentence                     | The data namespace has no content yet. If the panel has a button, write `"alwaysRender": true`.                                                                                                                     |
| The list is empty, but the data was written                                       | `dataSource.namespace` does not match the namespace the runtime writes to, or the `$item` path is missing `value/`.                                                                                                 |
| The story-text block never appears                                                | The data was not written to the `message` namespace, or `__turnId` is missing, or only a button inside the block would write it (see rule 3 in section 4).                                                          |
| Clicking a button does nothing                                                    | The action name is misspelled, or this action is not available in this place (see the table in section 3). The `runtimeId` for `invokeRuntime` must be complete: `plugin-name/runtime-name`.                        |
| You changed the file, but the interface did not change                            | The page was not refreshed. In an environment not started with `pnpm dev`, restart the backend.                                                                                                                     |
| The Chinese interface shows English                                               | This sentence is missing from `messages` in `locales/zh.yaml`, or the English original does not match the interface file exactly.                                                                                   |
| Your own HTML is blank                                                            | It is loading a script or style from the network, and that was blocked. Inline everything into this one file.                                                                                                       |

To see what data a panel actually receives: in development mode, press `Cmd/Ctrl+Shift+J` on the side panel that is open. A debug panel opens, showing that panel's interface file, its data, and its actions.

## Next steps

- **Look up what a component is called and what parameters it has.** See the [UI components reference](../reference/ui-components.md).
- **Look up all the fields of a panel file, and how several panels are merged.** See the [Panel reference](../reference/ui-panels.md).
- **Write instant actions, events, and player commands.** See the [Plugin fields reference](../reference/plugins.md) and the [Plugin extension reference](../reference/plugin-extensions.md).
- **Write tests for interface logic.** See [Plugin testing](./testing.md).
- **Make your own interface style.** See [Make a theme](../recipes/themes.md).

## Make a plugin view

1. Copy [session-view-probe](../../../tests/third-party/session-view-probe/README.md) to your user plugin directory. It contains no runtime or server entry.
2. Open `contributes.ui.view` in the root `PLUGIN.md` and inspect `story-view.json` and `notes-view.json`. The former reads the story in single-file HTML; the latter uses `Stack` and `Text` without session data. When editing English labels, update `locales/zh.yaml` too.
3. Enable the plugin in a session and choose “Story reader” from the header’s “Plugin views” menu. A reading consent prompt appears first. The story is shown only after consent. Use “Back to default view” to return, or revoke access from the view bar menu. Editing the spec or HTML requires consent again.

See the [plugin view reference](../reference/ui-panels.md#plugin-views) for projection scope, fields and limits. This sample submits no actions or forms and has no composer or images.

| Problem                          | What to do                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| The menu has no view             | Enable the plugin in this session and inspect `/api/ui-specs` diagnostics                           |
| The page is blank after consent  | Check that HTML uses a classic script and `window.covel.subscribe`; leave with the host back button |
| A page stays hidden without data | Add `alwaysRender: true` to a json-render page without a data source                                |

## Multi-file pages

For a view with separate scripts, styles and images, register a JSON spec under `contributes.ui.view`:

```text
my-plugin/
  PLUGIN.md
  ui/view.json
  ui/app/index.html
  ui/app/app.js
  ui/app/style.css
  ui/app/img/logo.png
```

```yaml
contributes:
  ui:
    view: [./ui/view.json]
```

```json
{
  "id": "console",
  "label": "Console",
  "webview": { "root": "./ui/app", "entry": "index.html" },
  "bridge": "session"
}
```

```html
<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="style.css" />
    <script src="app.js" defer></script>
  </head>
  <body>
    <img src="img/logo.png" alt="Logo" />
    <p id="story"></p>
  </body>
</html>
```

```js
window.covel.subscribe((state) => {
  document.querySelector("#story").textContent =
    state.session?.messages.map((message) => message.text).join("\n") ?? "";
});
```

Translate the label through the package message catalog:

```yaml
messages:
  Console: 控制台
```

`root` is relative to the package, while `entry` is relative to `root`. Use external classic scripts: inline scripts and modules do not run. The host injects `window.covel`; remove `bridge` when the page needs no session data. A session-reading page is mounted only after player consent. The player keeps the host back button and can retry a failed page. See [multi-file pages](../reference/ui-panels.md#multi-file-pages) for the file rules, limits, CSP and cache contract. Keep private files out of the published root. For custom fonts, use an embedded `data:font/woff2;base64,...` (or WOFF) in CSS `@font-face`. Even a relative font URL under the published root fails because the sandboxed document has an opaque origin and the route supplies no CORS allow headers.
