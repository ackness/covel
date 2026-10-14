### Added

- **A session tells the player when its memory index was built with another embedding model, and rebuilds it in one click.** Before, changing the embedding model paused vector memory in older sessions until the old model settings were restored, retained the old vectors, and logged a warning after every turn. Now the session shows "Memory search is matching keywords only" with a "Rebuild index" button ("Clear index" when no embedding model is configured). The rebuild measures the new model first and changes nothing when its configuration is invalid or it does not answer; then one transaction deletes the session's old vectors and index progress and locks it to the new model, and the index is built again in the background. Endpoints: `GET /api/sessions/:id/memory-index` and `POST /api/sessions/:id/memory-index/rebuild` (`docs/reference/api.md`).

### Changed

- **A changed embedding model is logged once per session.** Ingestion notes the mismatch once instead of after every turn, and memory search falls back to keywords without a warning each time. An index write now names the model it was embedded with, so vectors from the model an index was moved away from are refused (`docs/reference/slots.md`).
