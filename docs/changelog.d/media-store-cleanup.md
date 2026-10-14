### Fixed

- **Media generation no longer slows down as other sessions add media.** The cache lookup behind `ctx.images.generate()`, `ctx.speech.generate()` and `ctx.music.generate()` now reads only the calling session's own assets (SQLite and PostgreSQL query by owner, using the owner index) instead of the whole media inventory.
- **`MEDIA_BACKEND=pg` without `DATABASE_URL` stops the server.** It used to turn media off without a word, so every media route answered 503. Set `MEDIA_BACKEND=none` to run without media on purpose.

### Removed

- **The IndexedDB `MediaStore` and the `@covel/store/indexeddb` entry point.** Nothing used them: browser-private play keeps its media on the server, and the web app's display cache is separate. `MediaStore.delete()` also loses its `opts.force` parameter, which no backend read; `delete(id)` always removes the asset with every claim on it.
