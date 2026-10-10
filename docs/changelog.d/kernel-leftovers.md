### Breaking

- **`GET /api/sessions/:id/view` returns only the answers to the turns of its message window.** `submittedInteractions` held every answer of the session and grew with each choice; it now holds the answers whose `turnId` belongs to a returned message (the message's `turnId` or its form block's `meta.turnId`). The web client marks only blocks of that window, so it shows the same. A client that looked up an older turn's answer in this list no longer finds it. See `docs/reference/api.md`.
- **`DataStore.listTurnMessages` takes `{ turnId }`.** The second argument is `PaginationOpts & { turnId? }`; with `turnId` only that turn's messages are returned. A `DataStore` implementation outside this repository must honour the option, or a form answer is checked against the wrong messages. The three built-in backends do, under a shared contract test.

### Changed

- **A refused `emit-event` to a topic nobody declared no longer fails the runtime.** The call is still reported to the model as failed and is no business work (`requireToolUse` and `completeAfterTools` are not satisfied by it), but an agent that then finishes with text or `runtime-done` succeeds, so removing the plugin that consumes a topic does not break the plugin that emits it. A payload that breaks the declared schema stays a failure. See `docs/reference/tools.md`.
- **A browser-stored session warns before it reaches the upload limit.** From 80% of the 64 MiB checkpoint limit the web client shows one notice per session and page load. Before, the first sign was a refused upload. See `docs/architecture/storage.md`.

### Fixed

- **World-model validation no longer slows down with the number of characters.** Name and alias conflicts are checked against one table of name keys instead of comparing every character with every other, and `ctx.world` validates only the writes buffered since its last read. With 200 characters of 3 aliases each and 15 buffered writes, one read of `ctx.world.characters` took 2.6 s and now takes under 10 ms. The rules are unchanged.
- **Answering a form reads only that turn's messages.** A submit read the session's whole message log three times.
- **A background job queued before a browser-private session was restored reads the runtime exports it should.** The checkpoint kept only the newest revision of each export, which a job frozen at an earlier instant cannot read; it found none and was skipped. While a job is unfinished the checkpoint now keeps the revision that was live when the job's source execution began and the later ones.
- **A tool call without an ID is kept in a Chat Completions reply that is not streamed.** It was dropped, so the model's call never ran; it now gets the same derived ID as in a streamed reply.
