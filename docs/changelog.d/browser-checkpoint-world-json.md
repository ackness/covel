### Fixed

- **A browser-private save syncs again after its world was edited.** Once the browser had updated a world on the server (a self-hosted server lets it; the first sync does), every later save upload was refused with "world.metadata.worldDataPath must be a JSON-serialisable value": the server kept its own world record, which held fields without a value, and a save must be plain JSON. The server now stores that record in the save as JSON.
