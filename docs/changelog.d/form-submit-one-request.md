### Breaking

- **A form is answered through `POST /api/actions`, not through plugin-rpc.** The framework action `framework.submit-form` on `POST /api/sessions/:id/plugin-rpc` is gone (it now returns `404 unknown_action`), and so is the second request that sent the filled narrative as a `send_message`. A client sends one action, `{ type: "submit_interaction", payload: { turnId, submissions } }`, and reads the answer and the follow-up turn from that one SSE stream. Contract: `docs/reference/api.md`, the player interaction section.
- **A refused answer arrives on the stream, not as HTTP 400.** `form_rejected` (with `details.issues`), `interaction_already_submitted` and `invalid_interaction_submission` are the `code` of a single `error.occurred` event on a `200` stream that stores nothing and starts no turn. A request for the form provider's code grant is still a `202` JSON response before the stream opens.
- **Submitting the same answer again is refused, whatever its values.** The server no longer accepts a resubmit of identical values to hand the stored narrative back: an answered interaction always has its turn, so a client that lost the response reads `submittedInteractions` and `GET /api/sessions/:id/execution` instead of sending again.
- **`submittedInteractions[].followedUp` is removed from the session view.** An entry in that list always has a turn after it. A development session that holds an answer stored by an earlier build with no turn after it now shows that form as answered; send any message to continue it, or recreate the session.
- **`@covel/runtime` no longer exports `createSubmitFormHandler`.** `createInteractionSubmitter` validates an answer and returns the rows for the caller to store in its own transaction.

### Added

- **`interaction.submitted` SSE event.** It is the first event of a `submit_interaction` stream: the values the server stored, each filled narrative, and the id and text of the player message the follow-up turn carries. Payload: `docs/reference/protocol.md`.

### Changed

- **`submitBehavior.echoFilledNarrative` is read by the server.** It comes from the committed interaction, not from the request. With `false`, that interaction's narrative is left out of the follow-up turn's player message, as before.

### Fixed

- **Answering a form stores the answer and starts its turn as one operation.** They used to be two requests, so a second tab, a retry or a page closed between them could run the follow-up turn twice or leave an answer stored with no turn. The answer is now checked under the session lock and written in the same transaction as the turn's start; of two requests that submit one form together, one runs the turn and the other is told the form was already answered. A turn that has started runs to its commit when the connection drops.
