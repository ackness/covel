### Fixed

- **A browser-private session no longer gets stuck after an interrupted turn and a world edit.** When the page closed right after a turn's result was saved, and the world was edited before the next turn, every later action failed with "already committed with different data". The result and the end of the pending turn are now saved in one write, and a repeated result is recognised by what the server sent, not by the browser's copy of the world. Flow: `docs/internals/storage.md`.
