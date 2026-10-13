# Documentation authoring

These instructions apply to files under `docs/`. The directory is the
reader-facing documentation, built into the documentation site by `apps/docs`
(VitePress) and served under `/docs/` of the showcase site.

## Structure

- Chapters follow the order a reader meets the product: `start/` (play),
  `worlds/`, `plugins/`, `ship/`, `recipes/`, `reference/`, `internals/`.
  Read `README.md` here before adding a page; it lists every page and its state.
- A new page is added to the `sidebar` in `apps/docs/.vitepress/config.ts` and
  to the page list in `README.md`. `README.md`, `AGENTS.md` and `CLAUDE.md` are
  excluded from the site.
- Run `pnpm --filter @covel/docs build` after every change. A dead link fails
  the build.

## Writing a page

- Write short, plain prose that a player or a new developer understands. One
  idea per sentence. Say what the reader does and sees before naming the
  internal concept behind it. Introduce a term only when the page needs it,
  explain it in one plain sentence, and never define a term through other
  terms the reader has not met. Prefer a small example to an abstract
  description, and cut detail the reader does not need for the task at hand.
- Write for one reader with one goal. A tutorial opens with what the reader
  will have at the end and what they need first, then gives numbered steps.
  Every step that runs something shows the expected result, and the page ends
  with a table of failures and what to do about each.
- Run every command and paste the output it really gave. Check every label
  quoted from the app against `apps/web/src/i18n/locales/zh-CN.json`, and every
  field, default and identifier against the current schema, types or tests.
  Do not describe planned behaviour as available.
- Keep player instructions apart from implementation detail. Introduce a term
  the first time it appears, and use the terms of `docs/reference/glossary.md`.
- A page that is not written yet is not created as a stub.
- Examples are community packages in the user directories (`~/.covel/worlds`,
  `~/.covel/plugins`). They do not rely on builtin trust, on a concrete plugin
  ID in framework code, on private APIs or on a path of the author's machine.

## Links and format

- Link to another page of the site with a relative path ending in `.md`. Link to a page
  outside `docs/` with a relative path too: the site turns it into a link to
  the same file on GitHub, so the Markdown works in both places.
- Use GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
  `> [!CAUTION]`) for callouts. They render on GitHub and on the site. Do not
  use VitePress `:::` containers.
- Pictures live in `docs/public/` and are referenced from the root
  (`/stage-mode.webp`).
- The Chinese pages (everything outside `en/`) are the source: prose is
  Simplified Chinese; code, identifiers, commands and code comments are
  English.

## The English edition

`en/` holds the English edition, one file per Chinese page at the same relative
path, served under `/docs/en/`. It is a translation, never a second source:

- Change the Chinese page first, then make the same change in the page under
  `en/` in the same pull request. A new page gets its English page in the same
  change, and a deleted or moved page takes its English page with it.
- An English page has the same headings in the same order as its Chinese page,
  the same tables and the same code blocks. Links between English pages use
  the English page's own heading anchors. A link that leaves `docs/` needs
  one more `../` than in the Chinese page.
- UI labels are the ones the English app shows
  (`apps/web/src/i18n/locales/en-US.json`), plugin names are the `displayName`
  of each `PLUGIN.md`, and the terms are those of `en/reference/glossary.md`.
- Sample data that is Chinese on purpose (the sample world of the tutorials,
  the bundled Chinese worlds) stays Chinese in code blocks.
- `en/reference/schema/` is generated together with `reference/schema/` by
  `pnpm schemas:generate`. `en/changelog.md`, like
  `changelog.md`, only includes `docs/CHANGELOG.md`.
- The navigation labels of the English edition are the `EN` table in
  `apps/docs/.vitepress/config.ts`; a sidebar label without an entry there
  fails the build.

## One page per rule

A field, a default, a limit or an error is defined on one page, normally under
`reference/`. Guides link to that page instead of repeating its tables. When a
change makes two pages state the same rule, keep the reference one and link to
it from the other.

Reference and internals pages are linked by heading anchor from many places
(source comments, skills, the root `AGENTS.md`). Keep an existing heading text
when editing; when it must change, put `<a id="old-anchor"></a>` on the line
above the new heading.

Some pages are read by tests (`pnpm test:docs`): the manifest examples in
`plugins/essentials.md`, `plugins/local-code.md` and `plugins/advanced.md`, the
tables of `reference/tools.md` and `reference/ui-panels.md`, the event table of
`reference/hooks.md`, and `reference/env-registry.md`. `reference/schema/` is
generated by `pnpm schemas:generate` and is never edited by hand.
