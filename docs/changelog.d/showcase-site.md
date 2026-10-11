### Changed

- **The app opens on the world list.** `/` in the web app and the desktop shell now goes straight to the world list, and the Covel logo leads there too. The showcase page that used to sit at `/` is gone from the app, along with its video and images, so the desktop package no longer ships them.

### Added

- **A separate showcase website.** `apps/site` is a static site with new sections and copy in English and Chinese, a light and a dark theme, and the four bundled worlds. Run it with `pnpm --filter @covel/site dev`; `pnpm --filter @covel/site build` writes `apps/site/dist/`. The demo media script moved with it: `pnpm --filter @covel/site build:media`.

### Removed

- **`VITE_ROUTER_DEVTOOLS`.** The TanStack Router devtools showed only on the old showcase page, so the button and its variable are removed.
