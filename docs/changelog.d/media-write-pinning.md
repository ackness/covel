### Fixed

- **Fresh media can no longer be deleted by a cleanup that runs while it is being saved.** Uploads, `ctx.media.put()` and `ctx.media.ingestUrl()` now store their bytes together with a temporary `media-pin:<uuid>` reference and drop it once the session owns them. Before, "Delete all unused" or `POST /api/media/cleanup` could remove an image between the two steps and leave a placeholder. Rule: `docs/reference/media-store.md`.
- **A failed multi-image `ctx.images.generate()` call leaves no images behind.** Every image is stored first and the session claims them together; when one fails to download or save, none is claimed and the bytes are left to media cleanup, instead of a partial batch that stayed in the session.
- **A failed session delete keeps the session's media readable.** The session is deleted before its media claims are released, so a delete that fails no longer leaves a session that shows placeholders for its own pictures. When finishing a new session fails and deleting it fails too, the import's temporary references are still released.

### Changed

- **One prefix for every temporary media reference.** World-data imports now pin their bytes as `media-pin:<uuid>` instead of `world-data-import:<uuid>`, and `POST /api/media/cleanup` expires `media-pin:` references older than 24 hours. A `world-data-import:` reference left in development data no longer expires; recreate that data or remove the reference by hand.
