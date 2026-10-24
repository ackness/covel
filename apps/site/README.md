# @covel/site

The Covel showcase website: a static page that introduces the game to people
who have not installed it. It is separate from the app on purpose. The web app
and the desktop shell open on the world list, and nothing here is bundled into
either of them.

```bash
pnpm --filter @covel/site dev     # http://localhost:5174
pnpm --filter @covel/site build   # static files in apps/site/dist/
pnpm --filter @covel/site test
```

- `.github/workflows/site.yml` publishes the site on GitHub Pages at
  `https://ackness.github.io/covel/` (see `docs/CONTRIBUTING.en.md`). Vite's
  `base` comes from `SITE_BASE`, so refer to a file in `public/` through
  `asset()` from `src/links.ts`, never as `/name`.
- The "Docs" links open the documentation site (`apps/docs`), which the
  workflow publishes under `docs/` of this site. In development they point at
  its dev server on port 5175 (`DOCS_URL` in `src/links.ts`).
- Page text is in `src/copy.ts`; editable scene text is in `src/preview-copy.ts`.
  Each translated table must match the English table's type. The language picker
  uses the themed `LanguagePicker` combobox, generated from `LANGUAGES`, which also supplies HTML language tags and browser
  matching. To add an edition, add its metadata and tables to `COPY` (including
  its preview content and documentation path). Selection updates `?lang=` and the
  stored preference. Initial precedence is query, stored preference, browser.
- First visits use dark mode, regardless of the system appearance. The theme
  toggle stores the visitor's choice in `covel-site:theme`; `index.html` restores
  it before the first paint so refreshing does not flash or reset the palette.
  Both theme and language choices survive reopening the site in the same browser.
- The central examples are HTML in `src/components/PreviewScenes.tsx`,
  styled in `src/previews.css`. Edit dialogue, choices, quests, inventory, story and
  fields in `src/preview-copy.ts`; swap art in `PREVIEW_ART`. They follow the
  page language and theme. They are labelled illustrative previews with no live
  session, model call or editable player state. Scenes share one reserved grid area
  and crossfade every twelve seconds while the hero is in
  view, with brief character, dialogue and panel entrances. Section galleries reveal
  once; artwork hover motion is subtle. Rotation can be paused; selecting
  a mode or focusing its tabs pauses it, and reduced-motion disables autoplay and
  scene entrances. The original staggered headline and descriptions stay in sync
  with the selected scene.
- Each scene advances through three four-second moments before changing worlds.
  `journey-copy.ts` holds captions and sample outcomes; `MOMENT_PLUGINS` maps each
  moment to the responsible plugins and highlights them in the rack. Selecting a
  moment pauses autoplay. World-specific panels (routes, case board, power grid)
  are attributed to `world-init`, with storm time also supplied by `world-time`.
  `PACKS` is a curated presentation subset of each world's preset requests, `plus`
  and core defaults, not the complete resolved runtime registry. Recommended-only
  plugins are not shown as enabled. Tests compare these choices with repository
  world policies and manifests; source links open each world's `world.yaml`.
  The site test task declares these root-level fixtures in `turbo.json`, so changes
  to builtin packs, world policies or plugin manifests invalidate cached results.
- The carousel presents four curated play experiences: visual novel, tabletop
  campaign, interactive fiction and survival sandbox. These are examples built
  from plugins and world settings, not four exclusive engine modes. The survival
  scene uses Emberback Relay's storm, power and rescue setting; its plugin rack
  follows that world's preset and additions. Language support is a shared feature
  in `LanguageFeature.tsx`, outside the play carousel, with text in
  `preview-copy.ts` under `languages`.
- `authoring-copy.ts` holds the plugin/world-pack explanation, in-app world generation
  and workspace Agent Skills paths, and small ecosystem directory links. `SkillInstall.tsx` provides the copyable, scoped `npx skills add` command and keeps source links available. The page
  progresses from play examples to foundations, plugin interactions, creation,
  world examples and one download section. Sticky desktop navigation highlights the
  current section; a horizontal quick navigation remains visible on small screens.
- `PluginWorkbench.tsx` adapts dice, quest, affinity and codex panels as interactive
  browser examples. Edit both languages in `workbench-copy.ts` and styles in
  `workbench.css`. Dice use browser randomness; quest progress, character selection
  and codex filters are local demonstration state. `RelationshipExample.tsx` adapts the `npc-graph` panel with selectable character nodes and highlighted connections; graph facts and player affinity remain separate. `PluginExtensions.tsx` introduces optional image and speech plugins so the four interactive examples are not presented as the full catalog. Reset or switching tabs starts
  that example again. They do not execute plugins or persist player data.
- Layout references are the app's `StageHud`, `StageDialog`, `StageChoices`,
  `chat-messages/message-primitives.tsx`, `world/world-editor.tsx`, and the quest
  and inventory plugin panels. The site adapts their presentation without importing
  app components, stores or runtime packages.
- `public/previews/library-{day,night}.webp` are copied from
  `worlds/haruka-academy/media/scenes/`; `mio.webp` is copied from that world's
  `media/portraits/kamishiro-mio.webp`. Refresh these copies when the originals
  change. Keep art separate from translated HTML; use `asset()` for every path.
- The hero and sticky navigation link to one **Downloads** section. `downloads.css` lays out a single platform catalog with compact file rows and primary installer actions, rather than equal-height nested cards. It always lists
  macOS Apple silicon and Windows x64, regardless of visitor platform, with
  individual download and copy-link controls. It includes macOS DMG/ZIP and Windows
  installer/ZIP/self-extracting EXE. Windows always reserves installer, ZIP and portable rows, with the installer recommended. Missing assets have a non-clickable availability label; release assets enable links automatically. ZIP avoids repeated extraction; portable extracts on each launch. A missing installer does not hide other files.
  `src/download.ts` matches the filenames from `apps/desktop/electron-builder.yml`;
  update these patterns if artifact names change. Offline, rate-limited, malformed
  or stalled responses keep a visible release-page fallback. Clipboard failures
  leave the ordinary download links available for manual copying.
- The four world pictures in `public/worlds/` are 960-wide copies of each bundled
  world's `cover`. Refresh one after its world's cover changes.
- `public/media/` holds the demo video and poster. `pnpm --filter @covel/site
build:media` regenerates them (`docs/CONTRIBUTING.en.md`).
