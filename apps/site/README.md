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
- All text is in `src/copy.ts`, once in English and once in Chinese. The
  Chinese table has the English table's type, so a missing line fails `tsc`.
  The page picks `?lang=`, then the visitor's earlier choice, then the
  browser language.
- The download buttons start as a link to the latest release page. On macOS
  and Windows, `src/download.ts` asks the GitHub API for the latest release and
  links its `.dmg` or Windows installer (plus the portable build) by the file
  names `apps/desktop/electron-builder.yml` gives them; rename those and update
  the patterns together.
- The four world pictures in `public/worlds/` are 960-wide copies of each bundled
  world's `cover`. Refresh one after its world's cover changes.
- `public/media/` holds the demo video and poster. `pnpm --filter @covel/site
build:media` regenerates them (`docs/CONTRIBUTING.en.md`).
