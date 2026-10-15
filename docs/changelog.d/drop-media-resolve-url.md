### Breaking

- **`MediaStore.resolveUrl()` and `ctx.media.resolveUrl()` have been removed.** Plugin authors should use `ctx.media.get(ref)` to read bytes or pass a `MediaRef` to the UI for display. Browser clients that need a fetchable URL use `GET /api/sessions/:id/media-token`. Custom media stores and test doubles should remove the method; existing media data needs no changes. See [Media store](../reference/media-store.md).
