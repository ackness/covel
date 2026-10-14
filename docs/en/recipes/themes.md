# Make and Share Themes

This page explains how to give Covel its own look: colors, fonts, corner radius, and even the layout of the interface. It is written for players and designers, and for anyone who is willing to write a little CSS by hand.

There are two routes. You can use the first one alone:

- **No code**: pick a close style in Settings, adjust it until you are happy, and save it as your own theme. About ten minutes.
- **Hand-written CSS**: write a theme file. You can add animations, glass effects and other things that cannot be set in Settings.

Both routes produce the same kind of thing, called a **theme package**: a file that you can export, send to someone else, and import again.

## Get to Know a Few Terms

Open **Settings → Appearance**, and you will see these items:

| Name on screen | What it is                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Style          | A set of cards, one for each style. The built-in styles are "Panel", "Book", "Stage" and "Classic". The styles differ not only in color but also in the layout of the interface |
| Colours        | Several color sets within one style. "Classic" has four: "Paper", "Modern", "Abyss" and "Aurora"                                                                                |
| Color scheme   | Light or dark. Some themes have only one, and then the switch is locked automatically                                                                                           |
| Fine tuning    | On top of the current theme, change colors, fonts and sizes one item at a time                                                                                                  |
| Theme Library  | The themes you have imported and saved are here. You can apply, export and delete them                                                                                          |

Every color set is a complete theme package. A theme you make will also end up as one color set under a style, or as a style of its own.

## Route 1: No Code

### 1. Pick the Closest Style

Click a card under **Settings → Appearance → Style**. It takes effect right away. For a style that has several color sets, pick one under "Colours" below the card.

Picking the right style matters, because the layout of the interface follows the style:

| Style   | Navigation | Right-panel tabs | Picture of the world in play        | World list                            | Results of each turn                   |
| ------- | ---------- | ---------------- | ----------------------------------- | ------------------------------------- | -------------------------------------- |
| Classic | Top        | Vertical icons   | A very faint picture across the top | Cards with full covers                | Folded below the story text            |
| Book    | Top        | Tabs with text   | A chapter banner at the start       | Reading list                          | In a margin beside the story text      |
| Stage   | Top        | Tabs with text   | Scene picture fills the area        | Cover display                         | The latest turn is expanded by default |
| Panel   | Left icons | Tabs with text   | Not shown                           | Cards with the picture above the text | The latest turn is expanded by default |

You cannot change these layouts in Settings. A theme you save keeps the layout of the style you chose.

### 2. Change Things in "Fine Tuning"

Scroll down to "Fine tuning". The items you can change are split into eight groups by area. Open a group to change it:

| Group          | What you can change                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Narrative      | The color, font, size, line height, weight, letter spacing and column width of the story text     |
| Interface text | The font, and the style of titles and small labels in the interface                               |
| Surfaces       | The background colors of the page, the sidebar, cards, dialogs and player messages                |
| Text & edges   | Text color, secondary text color, primary color, and dividing lines                               |
| Accents        | The main accent color, the secondary accent color, and the colors for success, warning and danger |
| Ambience       | The background texture and how strong it is                                                       |
| Shape & depth  | The corner radius of cards, buttons and dialogs, and the shadow of cards                          |
| Layout         | The width, height and padding of each panel                                                       |

The "Narrative" group has a "Reading preview" block, where you can see the effect right away as you change things.

Three things to know:

- **Colors are saved separately for each mode.** A color you change in light mode applies only to light mode. When you switch to dark mode, you need to adjust it again. Fonts, sizes, corner radius and layout are shared by both modes.
- **Adjustments do not follow the theme.** If you switch to another theme, the items you changed are still applied on top of the new one. To see the new theme as it was designed, click "Reset all".
- **Each item can be reset on its own.** Click the reset button next to an item to go back to the theme's default value.

### 3. Save It as Your Own Theme

Find "Save as theme package" under "Fine tuning", enter a name, and click "Save as".

Covel combines the current theme and all your adjustments into a new, independent theme, then switches to it automatically. It also clears the changes in "Fine tuning", because those values are now part of the new theme. The gradients, animations and glass effects of the original theme are all kept.

The new theme appears in two places:

- In "Style", as a new color set under the style it came from.
- In "Theme Library", marked "Custom".

Saving again with the same name updates that theme. It does not create a second one.

### 4. Export and Send It to Someone

Expand "Theme Library" and click Export on the row of your theme. You get a file named `<theme ID>.theme.json`. Send that file to someone.

For how the other person imports it, see [Import a theme](#import-a-theme) below.

> [!NOTE]
> The top-right corner of "Fine tuning" also has "Import" and "Export" buttons. That pair exports only the items you changed, not a complete theme. To share a complete theme, use "Save as theme package" and then export it from "Theme Library".

## Import a Theme

1. Open **Settings → Appearance**, and expand "Theme Library".
2. Click "Import theme", and choose a `.css`, `.json`, `.theme` or `.theme.json` file.
3. After a successful import, a message "Imported ……" appears, and the app switches to this theme right away.

An imported theme is saved in this device's settings, and it is still there after a restart. On another device, you need to import it again.

> [!WARNING]
> Theme CSS can change or obscure the interface, but the page policy blocks its external resources. Background images are downloaded at import time. See the [theme package reference](../reference/theme-packages.md) for formats and limits.

## Route 2: Write a Theme by Hand

A hand-written theme is a piece of CSS. Covel colors its interface through a set of named "variables", such as "page background", "body text color" and "card corner radius". Your theme gives these variables new values, and the interface changes. You do not need to know how the interface is built inside.

### 1. Write a Minimal Theme

Create a new file `ember.css`:

```css
html[data-theme="ember"] {
  --color-background: #f6f2eb;
  --color-foreground: #241f1b;
  --color-card: #fffdf8;
  --color-primary: #7a4b2f;
  --color-border: #d9c8b5;

  --surface-rail: #fffaf2;
  --surface-elevated: #fffdf8;
  --surface-dialog: #fffdf8;

  --radius-card: 1rem;
  --radius-control: 0.75rem;

  --story-font-family: "Newsreader", serif;
  --story-font-size: 1.125rem;
  --story-line-height: 1.8;
}
```

`ember` is the ID of this theme. Import this file as described in the previous section, and it appears in "Style" and in "Theme Library". The name comes from the file name (`ember.css` shows as "Ember").

### 2. Add Dark Mode

Add another block, with `.dark` added to the selector:

```css
html[data-theme="ember"].dark {
  --color-background: #14110f;
  --color-foreground: #f1e7dc;
  --color-card: #1d1916;
  --color-primary: #ddb08c;
  --color-border: #3d322b;
}
```

> [!IMPORTANT]
> Whether the CSS file contains this `.dark` block decides which color schemes the theme supports. A CSS theme without this block has only light mode. To make a dark-only theme, use the JSON format below and write `"schemes": ["dark"]`.

### 3. Follow Four Rules

When you import, Covel checks the theme file. If it does not meet the rules, the import is refused, and the reason is given.

| Rule                                                                                                                          | Message when it is broken                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The theme ID uses only lowercase letters, numbers and hyphens, starts with a letter or number, and is 2 to 48 characters long | `Theme id must use lowercase letters, numbers, and hyphens.`       |
| A file uses only one theme ID                                                                                                 | `Theme CSS must use exactly one data-theme id.`                    |
| Every rule starts with `html[data-theme="your ID"]`                                                                           | `Every theme rule must be scoped to [data-theme="…"] — found "…".` |
| `@import` is not allowed                                                                                                      | `Theme CSS must not use @import.`                                  |

Also, do not use the IDs of the built-in themes (`panel`, `book`, `stage`, `paper`, `modern`, `abyss`, `aurora`). Built-in themes always take priority, and a custom theme with the same name is dropped.

### 4. Which Variables to Change First

There are many variables, but you do not have to write them all. A variable you leave out uses the framework's base value. Follow this order, and you will see a clear change at each step:

| Order | What to change              | Variables                                                                                                     |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1     | Main color tones            | `--color-background`, `--color-foreground`, `--color-card`, `--color-primary`, `--color-border`               |
| 2     | The background of each area | `--surface-page`, `--surface-rail`, `--surface-inset`, `--surface-elevated`, `--surface-dialog`               |
| 3     | Corner radius               | `--radius-card`, `--radius-control`, `--radius-dialog`                                                        |
| 4     | How the story reads         | `--story-font-family`, `--story-font-size`, `--story-line-height`, `--story-max-width`, `--story-color`       |
| 5     | Titles                      | `--title-font-family`, `--title-font-style`, `--title-font-weight`                                            |
| 6     | Dividing lines and accents  | `--rule-color`, `--rule-style`, `--accent-primary`, `--accent-success`, `--accent-warning`, `--accent-danger` |
| 7     | Shadows and ambience        | `--shadow-card`, `--shadow-dialog`, `--ambience-image`, `--noise-opacity`                                     |

A few variables are easy to use wrongly:

- `--surface-session` is the background of the central play area. When it is not written, `--surface-page` is used. You can write a semi-transparent color so the background effect underneath shows through.
- `--story-color` controls only the color of the story text. When it is not written, it follows `--color-foreground`.
- `--surface-player` is the background of player messages. Writing `transparent` removes the bubble.

For the full list of variables, see section 5 of the [theme package reference](../reference/theme-packages.md).

> [!TIP]
> The more complete the variables you write, the more the player can change in "Fine tuning" on top of your theme. But players can override any of your variables, so do not count on a color staying unchanged to keep text readable. Also do not add `!important` to these variables, because that would make the player's adjustments stop working.

### 5. Adjust Local Details

For details that variables cannot reach, use the fixed set of class names in the interface. They all start with `.ui-`. Write them after the theme ID, with the class name:

```css
html[data-theme="ember"] .ui-rule {
  border-style: dashed;
}

html[data-theme="ember"] .ui-message-player {
  background: transparent;
  border-width: 0 0 0 2px;
  border-color: var(--color-primary);
  border-radius: 0;
  padding-left: 0.875rem;
}
```

The most common ones:

| Class name                                    | Which part of the interface it is                   |
| --------------------------------------------- | --------------------------------------------------- |
| `.ui-app-header`, `.ui-nav-rail`              | The top navigation bar and the left navigation rail |
| `.ui-panel-header`, `.ui-panel-section`       | The title and sections of the right-side panel      |
| `.ui-panel-tabbar`, `.ui-panel-tab`           | The tabs with text in the right-side panel          |
| `.ui-title`, `.ui-eyebrow`                    | The title, and the small label above the title      |
| `.ui-narrative`                               | The story text                                      |
| `.ui-message-player`, `.ui-message-assistant` | The player's messages and the story's messages      |
| `.ui-composer`, `.ui-composer-input`          | The input area                                      |
| `.ui-choice-list`, `.ui-choice`               | The options the player picks from                   |
| `.ui-card-surface`, `.ui-dialog-shell`        | Cards and dialogs                                   |
| `.ui-chip`, `.ui-rule`                        | Small tags and dividing lines                       |
| `.ui-turn-updates`                            | The collapsible block of each turn's results        |

Change variables first, and use class names only where variables cannot reach. This way the theme is less likely to break in later versions. For the full list of class names, see section 6 of the [theme package reference](../reference/theme-packages.md).

**Add numbers to options.** The player can press the number keys 1 to 9 to pick the matching option. The numbers are hidden by default, but a theme can show them, as digits or as Chinese numerals:

```css
html[data-theme="ember"] .ui-choice-index {
  display: block;
}
html[data-theme="ember"] .ui-choice-index::before {
  content: counter(ui-choice, cjk-ideographic);
}
```

**Make the interface change with the game state.** Covel writes "how far the current turn has got" on the outermost layer of the page, and a theme can use it to add effects. For example, while the model is writing the story, the input area can slowly fade in and out:

```css
html[data-theme="ember"][data-turn="executing"] .ui-composer-input {
  animation: ember-breathe 2.4s ease-in-out infinite;
}

@keyframes ember-breathe {
  50% {
    opacity: 0.6;
  }
}
```

The values of `data-turn` are `idle`, `executing` (generating), `waiting` (waiting for the player to fill in a form or make a choice), and `error`. For the other states that are available, see section 6.6 of the [theme package reference](../reference/theme-packages.md).

The built-in "Aurora" theme is an example you can copy from. It uses gradient layers, glass effects, glow, and the state-driven effect shown above. The file is at [`apps/web/src/themes/builtins/aurora/theme.css`](../../../apps/web/src/themes/builtins/aurora/theme.css).

<a id="fonts"></a>

### 6. Fonts

A theme cannot use `@import` to load a font stylesheet from the network. Choose fonts from these two groups:

- **Fonts that come with the app**, which you can name directly: `"Inter"`, `"Fraunces"`, `"Newsreader"`, `"Geist"`, `"Geist Mono"`, and the Chinese title font `"ZCOOL XiaoWei"`.
- **Fonts on the player's system**, such as `"PingFang SC"`, `"Microsoft YaHei"`, `"Songti SC"`.

When you write a font, always list a few candidates, and finish with `serif` or `sans-serif`:

```css
--story-font-family: "Newsreader", "Songti SC", serif;
```

Two points to note:

- The fonts that come with the app contain only Latin letters. Chinese body text relies on system fonts.
- `"ZCOOL XiaoWei"` has only one weight. Do not set it to bold.

## Choose the Layout of the Interface

CSS can change only how things look. Where the navigation sits (top or left), what the tabs look like, and how the world's pictures are used in play are all layout. To choose a layout, the theme must be written in JSON format:

```json
{
  "id": "ember",
  "label": { "zh-CN": "余烬", "en-US": "Ember" },
  "description": { "zh-CN": "暖色的纸本阅读风格" },
  "schemes": ["light", "dark"],
  "layout": { "preset": "book", "nav": "rail" },
  "cssText": "html[data-theme=\"ember\"] { --color-background: #f6f2eb; }"
}
```

| Field         | Required | Meaning                                                                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | The theme ID. The same rules as above apply                                                                               |
| `label`       | Yes      | The name shown. It can be a single line, or it can be written separately for each language                                |
| `cssText`     | Yes      | The theme's CSS, put in one whole string. Only the theme ID that matches `id` can be used inside it                       |
| `schemes`     | No       | The supported color schemes: `["light"]`, `["dark"]` or `["light", "dark"]`. When left out, both are treated as supported |
| `description` | No       | A one-line description                                                                                                    |
| `layout`      | No       | The interface layout. When left out, it is `classic`                                                                      |
| `group`       | No       | Which style this theme goes under, as one of its color sets                                                               |
| `groupLabel`  | No       | The name of the style card                                                                                                |

In `layout`, first use `preset` to pick a preset: `classic`, `book`, `stage` or `panel`, which correspond to "Classic", "Book", "Stage" and "Panel" in the table above. If needed, you can then change any one item on its own. The example above uses the Book layout, but moves the navigation to the left.

Five items can be changed on their own: `nav`, `panelTabs`, `backdrop`, `worldList` and `turnNotes`. For the values, see [the layout presets in the theme package reference](../reference/theme-packages.md#31-layout-presets-layout). If `layout` contains an item or a value that is not recognized, the whole theme is refused on import.

> [!TIP]
> `cssText` is awkward to write by hand, because every quotation mark has to be escaped. An easier way: import a CSS file first, export it from "Theme Library" to get a JSON file that is already converted, and then add `layout` to it.

### Make a New Color Set Under a Style

To add a blue set to the built-in "Panel" style, write `group`:

```json
{
  "id": "panel-ocean",
  "label": { "zh-CN": "海蓝", "en-US": "Ocean" },
  "group": "panel",
  "layout": { "preset": "panel" },
  "cssText": "html[data-theme=\"panel-ocean\"] { /* complete variable and class-name rules */ }"
}
```

After import, "Ocean" appears under "Colours" below the "Panel" card.

> [!IMPORTANT]
> Color sets under the same style do not inherit from each other. A variable that your color set does not write uses the framework's base value, not the value of the "Panel" style. To change only a few colors on top of a style, the safest way is Route 1: select that style, adjust it, save it as a theme package, export it, and then edit it by hand.

A theme without `group` forms a style of its own, with its own card.

## Combine the Two Routes

Setting basic colors and typography in Settings is quick, and hand-written CSS can add effects. The two can be used together:

1. In "Fine tuning", adjust the colors and fonts.
2. "Save as theme package".
3. Export the JSON from "Theme Library".
4. Write animations, glass effects and glow by hand in `cssText`.
5. Import it again. The ID is the same, so it updates the original theme.

## A Complete Template

You can copy this directly, replacing `my-theme` with your own ID:

```css
html[data-theme="my-theme"] {
  --color-background: #f6f2eb;
  --color-foreground: #241f1b;
  --color-card: #fffdf8;
  --color-card-foreground: #241f1b;
  --color-primary: #7a4b2f;
  --color-primary-foreground: #fffaf2;
  --color-border: #d9c8b5;
  --color-input: #d9c8b5;
  --color-muted: #efe4d7;
  --color-muted-foreground: #7d6f63;

  --surface-page: #f6f2eb;
  --surface-rail: #fffaf2;
  --surface-inset: #efe4d7;
  --surface-elevated: #fffdf8;
  --surface-dialog: #fffdf8;
  --surface-player: transparent;

  --rule-color: #d9c8b5;
  --accent-primary: #7a4b2f;

  --radius-card: 1rem;
  --radius-control: 0.75rem;
  --radius-dialog: 1rem;

  --title-font-family: "Newsreader", serif;
  --title-font-style: italic;
  --title-font-weight: 400;
  --title-text-transform: none;

  --story-font-family: "Newsreader", serif;
  --story-font-size: 1.125rem;
  --story-line-height: 1.8;
  --story-max-width: 42rem;
}

html[data-theme="my-theme"] .ui-rule {
  border-style: dashed;
}

html[data-theme="my-theme"] .ui-message-player {
  background: transparent;
  color: var(--color-foreground);
  border-width: 0 0 0 2px;
  border-color: var(--color-primary);
  border-radius: 0;
  padding-left: 0.875rem;
  padding-right: 0;
  padding-block: 0;
}

html[data-theme="my-theme"].dark {
  --color-background: #14110f;
  --color-foreground: #f1e7dc;
  --color-card: #1d1916;
  --color-card-foreground: #f1e7dc;
  --color-primary: #ddb08c;
  --color-primary-foreground: #1a130f;
  --color-border: #3d322b;
  --color-input: #3d322b;
}
```

## Check Before You Share

- After import, you can find it under "Style".
- Switch between light and dark, and check that the text is readable on each background.
- Look at the three places — the world list, the game screen, and Settings — and check that the style is consistent.
- Start a session and let one turn finish: the story text, player messages, options, input box and right-side panel should all work.
- Make the window narrow and look again.
- Set the core colors, `--surface-rail`, `--surface-elevated`, `--surface-dialog`, `--radius-card` and `--radius-control`. A theme aimed at reading also sets `--story-*`.

A theme should express one direction, and the result will be more complete. Three common directions:

| Direction       | Traits                                                                             |
| --------------- | ---------------------------------------------------------------------------------- |
| Tool-like       | Cool colors, compact, clear boundaries, lots of information visible on one screen  |
| Reading-focused | Warm colors, generous white space, loose line height, titles with a narrative feel |
| Immersive       | Dark colors, soft contrast, glowing focus areas                                    |

## When Things Do Not Work as Expected

| Symptom                                                                                                | Cause and fix                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| On import, the message `Theme CSS must include a selector like html[data-theme="your-theme"].` appears | The file has no `data-theme` selector at all. Every rule must start with one                                                                          |
| On import, the message `Every theme rule must be scoped to …` appears                                  | A rule does not start with your theme ID. The message quotes the start of that rule                                                                   |
| On import, the message `Theme CSS must use exactly one data-theme id that matches "…".` appears        | The `id` in the JSON differs from the theme ID in `cssText`                                                                                           |
| On import, the message `Theme CSS must not use @import.` appears                                       | Delete the `@import`. For how to write fonts, see the [Fonts](#fonts) section above                                                                   |
| Import succeeds, but the theme does not appear, or it disappears later                                 | You used the ID of a built-in theme. Choose another ID                                                                                                |
| An imported CSS theme cannot switch to dark mode                                                       | The file has no `html[data-theme="…"].dark` block. Add it and import again                                                                            |
| You changed a variable, but the interface did not change                                               | You changed the same item in "Fine tuning", and that value takes priority there. Click the reset button for that item, or "Reset all"                 |
| After switching themes, the colors still look odd                                                      | The same cause as above. Changes in "Fine tuning" do not follow the theme                                                                             |
| Some parts of your color set show the default look                                                     | A color set does not inherit from other members of its style. A variable you do not write uses the framework's base value, so write them all yourself |
| Chinese text does not use the font you wrote                                                           | The player's system does not have that font. The bundled fonts contain only Latin letters, so list system fonts as candidates for Chinese text        |

## What Next

- **Look up all variables, class names and fields.** See the [theme package reference](../reference/theme-packages.md).
- **Make a plugin interface you wrote follow the theme.** See [Add an interface to a plugin](../plugins/ui.md#let-the-interface-follow-the-style).
- **Give a world a cover and scene pictures.** Some styles fill the screen with the world's pictures. See [World art direction](../worlds/art-direction.md).
