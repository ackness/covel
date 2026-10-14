# Theme packages

A theme package decides how the Covel interface looks: the colors, the fonts, the corner radius, and how the navigation and panels are arranged. This page is the formal contract for theme packages. It lists their file formats, every field, the variables you can override, and the class names you can use.

It is written for two kinds of readers:

- Advanced players who want to share a theme package reliably
- Developers who maintain Covel's front-end theme system

To make your first theme step by step, read [Make a theme](../recipes/themes.md) first.

This page uses three terms over and over:

- **token**: a CSS variable that a theme can change, for example `--color-background`.
- **hook**: a fixed class name that the framework puts on an interface element, for example `.ui-composer`. A theme uses it to write styles for one specific part.
- **layout**: a structural choice, for example whether the navigation is at the top or on the left.

## 1. Entry points of the theme system

The theme system is made of these parts:

| Part                       | Location                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime registry           | `apps/web/src/theme-system/registry.ts`                                                                                                                                          |
| Runtime style injection    | `apps/web/src/theme-system/runtime.ts`                                                                                                                                           |
| Import parsing             | `apps/web/src/theme-system/validate.ts`                                                                                                                                          |
| Persistence                | `apps/web/src/theme-system/storage.ts`                                                                                                                                           |
| Built-in theme packages    | `apps/web/src/themes/builtins/*`                                                                                                                                                 |
| Layout presets (see §3.1)  | `layout.ts` (preset table, validation, publishing to `<html>`) · `use-theme-layout.ts` (components read the current layout) · structural styles `apps/web/src/styles/layout.css` |
| Appearance studio (see §9) | Token overrides `overrides.ts` · editable token list `token-schema.ts` · save as theme `theme-export.ts` · color tools `color.ts`                                                |

The current theme and layout are written on the `<html>` element. To switch the theme, change these attributes:

```html
<html
  data-theme="panel"
  data-scheme="dark"
  class="dark"
  data-layout="panel"
  data-nav="rail"
  data-panel-tabs="bar"
  data-backdrop="none"
  data-world-list="cards"
  data-turn-notes="inline"
></html>
```

Where:

- The `ui.appearance` setting stores the theme package ID, and it is written as `data-theme`. The default value is `stage` (Stage). A theme choice that is already saved stays the same.
- After the theme package's `layout` is resolved, it is written as `data-layout` and as one attribute for each option (see §3.1). There is no separate layout setting: the layout changes along with the theme package.
- `ui.scheme` stores the color scheme (light / dark), and it is written as `data-scheme` and as the `.dark` class that Tailwind expects.
- The theme package's `schemes` decides which color schemes it supports. A theme that supports only one scheme changes `ui.scheme` to that value automatically.

## 2. Supported import formats

An imported ID cannot match a builtin theme. Validation failures are displayed in the current UI language. Top-level rules must stay within their theme scope; commas inside `:is()`, `:where()`, brackets, and strings do not split selectors.

A theme package can be a CSS file or a JSON file.

### 2.1 CSS file

The runtime looks for a `data-theme` selector in the CSS and reads the theme ID from it:

```css
html[data-theme="ember"] {
  --color-background: #14171d;
}

html[data-theme="ember"].dark {
  --color-background: #090b10;
}
```

Parsing rules:

- At least one `html[data-theme="..."]` selector must appear.
- One CSS file can declare only one theme ID.
- The runtime treats the theme's `schemes` as `["light", "dark"]` only when a selector with this theme ID includes `.dark`.
- Other `.dark` selectors do not affect how the color scheme is inferred.

### 2.2 JSON file

JSON structure:

```json
{
  "id": "ember",
  "label": {
    "zh-CN": "余烬",
    "en-US": "Ember"
  },
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "深色余烬主题",
    "en-US": "A dark ember theme"
  },
  "layout": { "preset": "panel", "nav": "top" },
  "cssText": "html[data-theme=\"ember\"] { --color-background: #14171d; }"
}
```

A CSS file has no place to declare a `layout`, so a theme imported as CSS uses the `classic` layout. When you need another layout, use the JSON format.

> [!WARNING]
> **Theme CSS is untrusted content.** It shares a document with settings and can still change or obscure the interface; import only themes you want to use. `@import` is rejected, and the page CSP blocks styles, fonts and images from external hosts, including CSS `url()`, `image-set()` and `@font-face`. Same-origin resources, embedded images and local fonts remain available.
>
> When importing a theme file or committing a backdrop in the appearance studio, ordinary `url(https://…)` images are downloaded and embedded before saving. PNG, JPEG, WebP, GIF and AVIF are accepted, with a 5 MiB limit per image and a 15-second timeout. The image host must allow CORS reads; requests carry no credentials or referrer. A failed download leaves the change unsaved. Remote fonts and escaped remote URLs are unsupported; reimport existing remote backgrounds or replace them with local resources. Backups and raw JSON do not download images automatically; CSP still applies.

## 3. JSON field contract

| Field         | Type                               | Description                                                           |
| ------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `id`          | `string`                           | Theme ID. It must match `/^[a-z0-9][a-z0-9-]{1,47}$/`                 |
| `label`       | `string \| Record<string, string>` | Display name                                                          |
| `schemes`     | `("light" \| "dark")[]`            | Supported color schemes. If left out, it is `["light", "dark"]`       |
| `description` | `string \| Record<string, string>` | Optional description                                                  |
| `layout`      | `ThemeLayoutSpec`                  | Optional layout declaration, see §3.1. If left out, it is `classic`   |
| `group`       | `string`                           | Optional group ID, in the same format as `id`, see §3.2               |
| `groupLabel`  | `string \| Record<string, string>` | Optional display name for the group, see §3.2                         |
| `cssText`     | `string`                           | The theme CSS content. It must declare only the same theme ID as `id` |

### 3.1 Layout presets (`layout`)

Tokens and hooks can only change the appearance. The following are structure, and the theme package declares them in `layout`:

- Where the navigation goes;
- What the tabs of the right-side panel look like;
- How a session uses the world's art;
- How the world list is arranged;
- Where the results of each turn go.

You write it by choosing a preset first, and then overriding single options as needed:

```ts
interface ThemeLayoutSpec {
  preset?: "classic" | "book" | "stage" | "panel"; // If omitted, it is classic
  nav?: "top" | "rail";
  panelTabs?: "rail" | "bar";
  backdrop?: "ambient" | "scene" | "banner" | "none";
  worldList?: "covers" | "cards" | "list" | "showcase";
  turnNotes?: "fold" | "inline" | "margin";
}
```

The values for each option:

| Option      | Value      | Effect                                                                                                                                                                                       |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav`       | `top`      | A navigation bar at the top                                                                                                                                                                  |
|             | `rail`     | At desktop width, changes to a left icon bar. On narrow screens it still uses the top navigation bar and a menu popup                                                                        |
| `panelTabs` | `rail`     | The right-side panel switches tabs with a vertical icon bar                                                                                                                                  |
|             | `bar`      | The right-side panel has a horizontal tab bar at the top, with text on the tabs. When the tabs do not fit, the bar scrolls sideways, and a button at the end lists all tabs                  |
| `backdrop`  | `ambient`  | A very faint layer of the world picture at the top of the session                                                                                                                            |
|             | `scene`    | The current scene picture fills the session area (the `stage.backdrop@1` slot; if it is missing, it falls back to the world header picture), and the story text moves into the right sidebar |
|             | `banner`   | The world picture appears as a chapter banner above the first message, and scrolls with the history                                                                                          |
|             | `none`     | Does not show the world picture                                                                                                                                                              |
| `worldList` | `covers`   | World cards that show a full cover (two columns)                                                                                                                                             |
|             | `cards`    | Cards with the picture above and the text below (three columns). At the top there are "Continue your last adventure" and a search box. On hover, the cover cycles through scene pictures     |
|             | `list`     | A reading list with one world per line                                                                                                                                                       |
|             | `showcase` | The cover and scene-picture carousel of the selected world fills the full screen. Portraits sit below the introduction, and the other worlds form a row of thumbnails                        |
| `turnNotes` | `fold`     | The read-only results of each turn (checks, state changes, new discoveries) are folded below the story text                                                                                  |
|             | `inline`   | The results of the latest turn are expanded by default. Earlier ones stay folded                                                                                                             |
|             | `margin`   | The results go in a margin column next to the story text. If the session area is not wide enough, they fall back to below the story text                                                     |

The options for each preset:

| Preset    | `nav`  | `panelTabs` | `backdrop` | `worldList` | `turnNotes` |
| --------- | ------ | ----------- | ---------- | ----------- | ----------- |
| `classic` | `top`  | `rail`      | `ambient`  | `covers`    | `fold`      |
| `book`    | `top`  | `bar`       | `banner`   | `list`      | `margin`    |
| `stage`   | `top`  | `bar`       | `scene`    | `showcase`  | `inline`    |
| `panel`   | `rail` | `bar`       | `none`     | `cards`     | `inline`    |

Rules:

- **The values are fixed.** You can only use the values listed in the table above, and the object cannot contain keys that are not recognized. When you import JSON and the `layout` is not valid, the whole theme package is rejected. An invalid `layout` in a theme package that is already saved is discarded, and the theme falls back to `classic`.
- **Structural styles respond to options, not to themes.** The framework's structural styles match on the **option** attributes (for example `html[data-backdrop="scene"]`), not on the theme ID and not on the preset name. So a custom theme package that overrides only one option gets the matching structure too.
- **For developers.** A component reads the current layout through `useThemeLayout()`. To add a new structural option, change three places: the enum and the preset table in `layout.ts`, the components that use it, and the table in this section.
- **Save as theme package** keeps the `layout` of the source theme.

### 3.2 Style and color grouping (`group`)

The "Style" section in Settings groups theme packages into cards by `group`. Theme packages with the same `group` are one style, and each member is one color variant of that style. A theme package that does not declare a `group` forms a style of its own, and its group ID is its own `id`.

- **Each member is still a complete theme package**, and you can select it on its own. `ui.appearance` always stores a theme package ID. There is no separate "color variant" setting.
- **The name of a card** comes from this order:
  1. The first member that declares `groupLabel`;
  2. If none declares it, the `label` of the member whose `id` equals the group ID;
  3. If there is still none, the `label` of the first member.

  Built-in themes come first, so an imported theme package cannot change the name of a built-in group.

- **The name of a color variant** is the member's own `label`. A member whose `id` equals the group ID is shown as "Default".
- **The card's thumbnail, description, and layout** come from the member that is currently selected. If none is selected, they come from the first member. The framework does not require members of the same group to share a layout, but mixing different layouts in one group can confuse players.
- **Save as theme package** puts the new theme package into the group of the source theme, as a new color variant of that style.
- **To add a color variant to a style**: import a theme package whose `group` points to that style, for example `"group": "panel"`.

## 4. Structure of built-in theme packages

The directory structure of built-in themes:

```text
apps/web/src/themes/builtins/
  panel/
    manifest.json
    theme.css
  book/
    manifest.json
    theme.css
  stage/
    manifest.json
    theme.css
  modern/
    manifest.json
    theme.css
  paper/
    manifest.json
    theme.css
  abyss/
    manifest.json
    theme.css
  aurora/
    manifest.json
    theme.css
```

- `panel` (Panel), `book` (Book), and `stage` (Stage) are three "styles". Each one declares a layout preset with the same name. They are the reference implementations for writing a theme package that has a layout.
- `paper`, `modern`, `abyss`, and `aurora` use the `classic` layout and declare `"group": "classic"`. In Settings, they form four color variants of one "Classic" style.
- `aurora` is the reference implementation for effects: glassmorphism, flowing light, message entrance animation, and the state-driven effects of §6.6. If you want to write a "fancy" theme, write it the same way.

Here is how `aurora`'s flowing light works: it uses `transform` to rotate a static gradient layer. The size of the layer is set from the viewport diagonal plus blurred margin, so it covers the screen in both landscape and portrait while rotating. It does not change the gradient angle frame by frame, so the browser does not have to repaint again and again while scrolling.

The structure of `manifest.json`:

```json
{
  "id": "paper",
  "label": {
    "zh-CN": "纸本",
    "en-US": "Paper"
  },
  "source": "builtin",
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "温暖、偏叙事阅读器的纸本风格。",
    "en-US": "A warm editorial reading style."
  },
  "group": "classic",
  "groupLabel": {
    "zh-CN": "经典",
    "en-US": "Classic"
  }
}
```

A built-in theme with a layout has one more `layout` field in its manifest, for example `"layout": { "preset": "book" }`.

## 5. Shared token contract

The main job of a theme package is to override the semantic tokens. The full list of tokens is below, grouped by category.

### 5.1 Color tokens

- `--color-background`
- `--color-foreground`
- `--color-card`
- `--color-card-foreground`
- `--color-popover`
- `--color-popover-foreground`
- `--color-primary`
- `--color-primary-foreground`
- `--color-secondary`
- `--color-secondary-foreground`
- `--color-muted`
- `--color-muted-foreground`
- `--color-accent`
- `--color-accent-foreground`
- `--color-destructive`
- `--color-destructive-foreground`
- `--color-border`
- `--color-input`
- `--color-ring`

### 5.2 Surface tokens

- `--surface-page`
- `--surface-session`: the background color of the central game panel. If it is not set, `--surface-page` is used. You can use a semi-transparent color so the theme's flowing light shows through below it.
- `--surface-rail`
- `--surface-inset`
- `--surface-elevated`
- `--surface-dialog`
- `--surface-player`
- `--surface-empty`
- `--border-subtle`

Use only the token names above. Replace `--surface-app`, `--surface-panel`, and `--surface-panel-strong` in custom themes with `--surface-page`, `--surface-rail`, and `--surface-elevated` respectively. Color scheme changes are applied by the SettingsStore subscriber through `applyColorScheme`; there is no second theme provider or `covel:scheme` storage key.

### 5.3 Rule and accent tokens

- `--rule-color`
- `--rule-strong-color`
- `--rule-style`
- `--rule-thickness`
- `--rule-strong-thickness`
- `--accent-primary`
- `--accent-secondary`
- `--accent-warning`
- `--accent-danger`
- `--accent-success`

### 5.4 Radius, layout, and atmosphere tokens

- `--radius-card`
- `--radius-control`
- `--radius-dialog`
- `--radius-chip`
- `--panel-header-height`
- `--panel-section-padding-x`
- `--panel-section-padding-y`
- `--rail-width-left`
- `--rail-width-right`
- `--composer-max-width`
- `--session-column-max-width`
- `--ambience-image`
- `--ambience-blend`
- `--ambience-opacity`
- `--noise-image`
- `--noise-opacity`

### 5.5 Font and typography tokens

First, the fonts you can use:

- **Chinese fonts come from the system.** For example `"PingFang SC"`, `"Microsoft YaHei"`, and `"Songti SC"`. The app does not load Chinese web fonts from a font service. They are large, they make the whole page reflow again and again while loading, and when the font service cannot be reached they slow the first screen.
- **Latin fonts packaged with the app**: `"Inter"`, `"Fraunces"`, `"Newsreader"`, `"Geist"`, and `"Geist Mono"`. A theme package can use these names directly in its font stack.
- **One Chinese display font packaged with the app**: `"ZCOOL XiaoWei"` (站酷小薇). A theme package can use this name directly in its font stack, but do not make it bold, because it has only one weight, 400.
- **A theme package cannot use `@import`.** So the other Chinese fonts in a font stack should be system fonts, and the stack should end with a generic family name (`sans-serif` / `serif`).

Details of the packaged fonts:

- Latin fonts: SIL OFL 1.1, from the `@fontsource-variable/*` packages. The font declarations are in `apps/web/src/styles/fonts.css`. Only the Latin subset and the styles that the built-in themes use are packaged (Fraunces and Newsreader include the 400 italic; the weight is a variable axis). The first screen does not send a request to any font service, so the behavior is the same offline and in the desktop app.
- These fonts use `font-display: block`. Local files are ready in a few milliseconds, so there is no full-page reflow from showing a fallback font first and then switching.
- `"ZCOOL XiaoWei"`: OFL 1.1. The file is in `apps/web/public/fonts/zcool-xiaowei/`, and the font declaration is in `apps/web/src/styles/fonts.css`. It is read only when a theme uses this font family. `stage` uses it for its titles.

Token list:

- `--font-sans`
- `--font-display`
- `--font-serif`
- `--font-mono`
- `--type-display`
- `--type-body`
- `--type-mono`
- `--type-meta`
- `--eyebrow-font-family`
- `--eyebrow-font-size`
- `--eyebrow-font-weight`
- `--eyebrow-letter-spacing`
- `--eyebrow-text-transform`
- `--title-font-family`
- `--title-font-style`
- `--title-font-weight`
- `--title-letter-spacing`
- `--title-text-transform`
- `--story-color` (the color of the narrative text. By default it follows `--color-foreground`. The appearance settings save it separately for light and dark mode.)
- `--story-font-family`
- `--story-font-size`
- `--story-line-height`
- `--story-font-weight`
- `--story-letter-spacing`
- `--story-max-width`
- `--meta-font-family`
- `--meta-font-size`
- `--meta-letter-spacing`
- `--meta-text-transform`

Where these tokens apply:

- Ordinary Markdown text, headings, emphasis, and quotes use the theme's text color. Links and inline code use the theme's primary color.
- The text, headings, emphasis, and quotes in the narrative area use `--story-color`.
- The font size, line height, weight, letter spacing, and column width of narrative Markdown are controlled by `--story-*`.
- The styles are in `apps/web/src/styles/narrative.css`. It uses unlayered rules to override the Typography defaults that are in the `utilities` layer.

### 5.6 Shadow tokens

- `--shadow-card`
- `--shadow-dialog`
- `--shadow-pop`

## 6. Shared semantic hook contract

The following are the class names that the framework puts on interface elements. A theme can use them to write styles for one specific part.

### 6.1 Structure layer

| Hook                                                        | What it is                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.ui-app-header`                                            | The top navigation bar                                                                                                                                                               |
| `.ui-nav-rail`                                              | The left navigation bar when `nav: "rail"` is set                                                                                                                                    |
| `.ui-nav-item`                                              | A navigation item. Both navigation types share it. The current item has `aria-current="page"`                                                                                        |
| `.ui-session-header`                                        | The toolbar at the top of a session. Its class names are listed below                                                                                                                |
| `.ui-session-thumb`                                         | The world thumbnail in front of the world name in the toolbar. It is hidden by default. A theme opens it with `display: block` and gives it a size                                   |
| `.ui-panel-status`                                          | When `panelTabs: "bar"` is set, the player status bar below the tabs of the right-side panel. Its class names are listed below                                                       |
| `.ui-panel-tabbar` / `.ui-panel-tab` / `.ui-panel-tab-icon` | When `panelTabs: "bar"` is set, the tab bar, the tabs, and the tab icons of the right-side panel. The current tab has `data-state="active"`                                          |
| `.ui-panel-tab-menu`                                        | A button at the end of the tab bar that appears when the tabs do not fit. Clicking it opens a grid of all tabs                                                                       |
| `.ui-scroll-fade`                                           | A bar that scrolls sideways because it does not fit (the tab bar and the world thumbnail bar). The cut-off side fades out. `data-fade-start` / `data-fade-end` show which side it is |

Hooks with no extra notes:

- `.ui-panel-header`
- `.ui-panel-section`
- `.ui-panel-footer`
- `.ui-rule`
- `.ui-outline-rail`

Inside `.ui-session-header`:

- `.ui-session-title`: the title. When `backdrop: "scene"` is set and there is a scene name, it is the scene name. Otherwise it is the world name.
- `.ui-view-switch`: the "Text / Stage" switch. The selected item has `data-state="on"`.
- `.ui-session-action`: the buttons for back, settings, more, and the panel toggle.
- `.ui-menu-item`: an item in the "More" menu.

Inside `.ui-panel-status`:

- `.ui-panel-status-name`: the player name.
- `.ui-panel-status-title`: the title of the status bar ("Notebook"). It is hidden by default. A theme opens it with `display: block`.

### 6.2 Typography layer

- `.ui-title`
- `.ui-entry-title`
- `.ui-eyebrow`
- `.ui-narrative`
- `.ui-empty-title`
- `.ui-empty-copy`

### 6.3 Component surfaces

- `.ui-card-surface`
- `.ui-dialog-shell`
- `.ui-input-shell`
- `.ui-chip`
- `.ui-chip-name`
- `.ui-chip-dot`

### 6.4 Session experience

| Hook                                                                                                                                | What it is                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.ui-session-backdrop`                                                                                                              | The world decoration picture and fade layer at the top of the central panel. You can add a static mask so it blends into the semi-transparent background                                       |
| `.ui-session-scene-scrim`                                                                                                           | The dimming layer over the scene picture when `backdrop: "scene"` is set                                                                                                                       |
| `.ui-scene-hud`                                                                                                                     | When `backdrop: "scene"` is set, the characters present and the player status shown over the lower-left corner of the scene picture. Its class names are listed below                          |
| `.ui-chapter-banner`                                                                                                                | When `backdrop: "banner"` is set, the chapter banner above the first message. `.ui-chapter-banner-scrim` is the dimming layer over the picture                                                 |
| `.ui-status-meters`                                                                                                                 | The player status meters. The panel status bar and the scene HUD share it. The meters themselves use `.ui-meter-track` / `.ui-meter-fill`                                                      |
| `.ui-status-items` / `.ui-status-item`                                                                                              | The list of items the player carries, and the label of each item. These two places share them too                                                                                              |
| `.ui-panel-dialog`                                                                                                                  | The large dialog that opens when a plugin panel is expanded                                                                                                                                    |
| `.ui-summary`                                                                                                                       | The "label and content" list of the status summary: numeric attributes with no range, and the `session.summary@1` entries that plugins provide. Its class names are listed below               |
| `.ui-turn-updates`                                                                                                                  | The folding block for the read-only results of each turn (`<details>`. When expanded, it has `[open]`). When `turnNotes: "margin"` is set, this is the margin note                             |
| `.ui-choice-list` / `.ui-choice`                                                                                                    | The options offered to the player (plugins declare them with the `ChoiceList` / `Choice` components). Their class names are listed below                                                       |
| `.ui-story-surface`                                                                                                                 | The shared container of the message flow, the pending area, and the input box. When `backdrop: "scene"` is set, it is the story column on the right, and its background uses `--surface-story` |
| `.ui-message-row`                                                                                                                   | Has `data-role="user" \| "assistant"`                                                                                                                                                          |
| `.ui-message-role`                                                                                                                  | The role label above a message ("Player" / "Assistant"). A theme can hide it or change it to an inline marker                                                                                  |
| `.ui-composer`                                                                                                                      | The outer layer of the input area                                                                                                                                                              |
| `.ui-world-heading`, `.ui-world-enter`, `.ui-world-tag`, `.ui-world-tile`, `.ui-world-row`, `.ui-world-showcase`, `.ui-world-thumb` | The headings, the main button (enter or continue), the tags, and the entries for the different layouts of the world selection page                                                             |
| `.ui-world-continue`, `.ui-world-search`                                                                                            | When `worldList: "cards"` is set, the "Continue your last adventure" banner and the search box above the list                                                                                  |

Hooks with no extra notes:

- `.ui-session-column`
- `.ui-player-message-row`
- `.ui-message-player`
- `.ui-message-assistant`
- `.ui-composer-frame`
- `.ui-composer-input`
- `.ui-composer-submit`

Inside `.ui-scene-hud`:

- `.ui-scene-card`: each semi-transparent backing panel.
- `.ui-scene-cast[data-focused="true"]`: the character currently in focus.
- `.ui-scene-speaking`: the "speaking" marker.

Inside `.ui-summary`:

- `.ui-summary-label`: the label.
- `.ui-summary-value`: the content. It has `data-tone="info" | "success" | "warning" | "danger"`.

`.ui-choice` is a button. When it is selected, it has `data-selected="true"`. Inside it, in order:

- `.ui-choice-index`: the number. It is hidden by default. Its content is the CSS counter `ui-choice`, and a theme can change it to Chinese numerals or key caps.
- `.ui-choice-content`: contains `.ui-choice-title` and `.ui-choice-body`.
- `.ui-choice-eyebrow`: the label. Its `data-tone` is written on `.ui-choice`.

When an option has a secondary action below it, there is one more wrapper, `.ui-choice-row`, outside it, and the action is inside `.ui-choice-actions`. In the stage view's decision panel, options also have `.ui-stage-choice-item` (the entrance animation and the focus ring).

### 6.5 Detail effects

- `.ui-meter-track`
- `.ui-meter-fill`
- `.ui-pulse-dot`
- `.ui-cursor`

### 6.6 State attributes (state-driven effects)

Besides class names, the framework also writes the state of the current turn on `<html>`. This lets plain CSS react to what is happening in the game:

| Attribute      | Values                                     | Meaning                                |
| -------------- | ------------------------------------------ | -------------------------------------- |
| `data-turn`    | `idle` / `executing` / `waiting` / `error` | The activity state of the turn         |
| `data-session` | `active` / `paused` / `ended`              | The session lifecycle                  |
| `data-theme`   | Theme ID                                   | The current theme (for scoping)        |
| `data-scheme`  | `light` / `dark`                           | The current light or dark mode         |
| `data-layout`  | Layout preset name                         | The layout preset of the current theme |

The layout options also have `data-nav`, `data-panel-tabs`, `data-backdrop`, `data-world-list`, and `data-turn-notes`. For their values, see §3.1.

`waiting` takes priority over `executing`. The turn is still open, but the kernel is waiting for the player to act (a form or a choice). This is the state that is worth highlighting.

```css
/* While the AI is generating, the input box breathes */
html[data-theme="my-theme"][data-turn="executing"] .ui-composer-input {
  animation: my-breathe 2.4s ease-in-out infinite;
}
```

> [!NOTE]
> The framework publishes these attributes itself, and they only cover the state the kernel knows about. Plugin-specific state (scene, mood, battle) cannot drive a theme yet. The framework does not hardcode plugin IDs, so this would need a channel that plugins declare by capability. That channel is not open yet.

## 7. Runtime behavior

When a theme is imported, the runtime does these steps in this order:

1. Read the file content
2. Parse the theme ID and the CSS
3. Validate the import format
4. Save to local settings
5. Inject `<style data-theme-style="theme-id">`
6. Register again with `ui.appearance`
7. Correct `ui.scheme` according to `schemes`
8. Show it in the settings panel and the theme library

## 8. Persistence behavior

Custom themes are saved in the `ui.customThemes` setting. Each record contains:

- `id`
- `label`
- `cssText`
- `schemes`
- `description`
- `layout`
- `group`
- `groupLabel`
- `importedAt`
- `fileName`

The runtime restores these records as `ThemeDefinition` objects, and sorts and registers them together with the built-in themes.

## 9. Appearance studio (token overrides / save as theme)

Players can change the look without writing any CSS. "Settings → Appearance" gives each adjustable token a control. Which tokens can change, which control each one uses, and which preset values exist are defined by `TOKEN_GROUPS` in `token-schema.ts`. This includes the font stacks `FONT_STACKS` and the ambience textures `AMBIENCE_PRESETS`.

**Where the override values are stored.**

- They are stored in the setting `ui.appearanceTokens`, in the shape `{ shared, light, dark }`.
- **Colors are stored separately for light and dark mode. Sizes, fonts, and corner radii are shared between the two modes.**
- A single value can be at most 2048 characters. This stops someone from pasting a data URL that fills the localStorage quota and breaks other settings.

**Overrides are global, not stored per theme.** `ui.appearanceTokens` has only three buckets: `shared`, `light`, and `dark`. After you switch themes, the same overrides still apply on top of the new theme. To return to the theme's original look, you have to clear the overrides explicitly (`clearOverrides`, or one at a time with `clearTokenOverride`).

**How overrides take effect.**

- `applyTokenOverrides()` writes `{...shared, ...current scheme}` as an **inline style on `<html>`**, so it takes priority over the theme package's ordinary declarations.
- A declaration with `!important` in the source theme can still beat an override. So an adjustable token should avoid `!important`.
- A property that was written in the last round and has been removed in this round is cleared explicitly, so nothing is left over.
- An invalid CSS value is discarded by the browser (CSSOM), and the result is that the theme's own value is used.
- Before a write, it is filtered by `isAdjustableToken`: only tokens declared in `TOKEN_GROUPS` can be overridden. Arbitrary CSS variables cannot be injected through this channel.

**How a control knows what the value is when there is no override.** `readTokenDefaults()` temporarily removes the overrides, reads the theme's original values, and then restores them, all in the same synchronous block. So the control can show the original value, and the browser never paints the in-between state.

**Save as theme.** `buildThemeCss()` in `theme-export.ts` takes the current theme definition, rebinds the scope of the source CSS to the new ID, and then appends a full snapshot of the tokens at the end.

- Pseudo-elements, gradients, media queries, turn state, and the order of `@layer` are all kept. The priority of `!important` in the source CSS does not change.
- `theme-css-derive.ts` replaces only selectors and animation identifiers. It does not re-serialize through CSSOM. So rules that the current browser does not yet support are not dropped.
- Animation definitions, `animation` / `animation-name`, and the custom properties that refer to them all switch to the new theme's own animation names.
- When you save as again, only the generated snapshot at the end is replaced. Source rules and animation name prefixes do not pile up each time.
- Both the source CSS and the final output must pass import validation. The output does not depend on the original theme's ID: you can export it as described in §8, delete the original theme, and then import it again.
- `slugifyThemeId()` / `ensureThemeId()` derive the ID from the name and avoid builtin IDs. If the final ID already belongs to a custom theme, saving asks before replacing it. Cancelling preserves the name, selection, and overrides. A theme changed during confirmation is preserved and saving asks the player to review it again.

**When saving fails.** Fine-tuning the appearance and resetting both wait for the real persisted result:

- When saving fails, the error is shown, the draft and preview from this one failed attempt are undone, and the saved values are restored. An edit started after that is not undone by the old failure callback.
- When a commit returns normally but is actually ignored (for example, a length input that is empty), the preview is redrawn with the value that was actually saved. When an old commit finishes, it does not overwrite later edits.
- A rollback redraw caused by the override subscription also keeps the new preview that is still waiting to be committed.
- When you close the panel or switch between light and dark mode, unsaved edits in the original mode are still committed. But a late callback does not redraw a new panel or a new mode.

"Apply", import, and save as theme in the theme library all wait for `ui.appearance` to finish saving:

- When saving fails, they do not go on to clear the overrides or the name, and they do not report "complete success".
- A custom theme record that was already saved can be kept. Between the three steps (the theme record, the selection, and the overrides), there is no automatic rollback across steps.

## 10. Compatibility advice

To keep a theme package stable and usable over the long term, we recommend this:

- Prefer overriding tokens
- Use `.ui-*` hooks for local visual differences
- Provide complete foreground and border colors for both light and dark
- Narrative themes should explicitly override the `--story-*` tokens
- Tool themes should explicitly override the `--surface-*`, `--radius-*`, and `--title-*` tokens

<a id="10-reference-examples"></a>

## 11. Reference examples

You can use the built-in themes as real references:

- `apps/web/src/themes/builtins/modern/theme.css`
- `apps/web/src/themes/builtins/paper/theme.css`
- `apps/web/src/themes/builtins/abyss/theme.css`
