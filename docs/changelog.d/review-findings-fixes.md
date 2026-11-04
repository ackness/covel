### Fixed

- **Auto-advance no longer stays off after the player skips a choice.** A choice the player answered by typing instead used to count as unanswered forever, so every later round stopped with `pending-input`. Only interactions after the player's last message count now, as in the UI. See [auto-advance events](../en/reference/protocol.md#auto-advance-events).
- **Input sent while the previous turn is saving is no longer lost.** If the session pauses or ends before the save finishes, or the send fails, the text goes back to the input box.
- **"Revising…" no longer lingers after a story agent stops.** When a rejected submission was followed by a suspension or a stop, the placeholder stayed until the action ended; it is now cleared with `reason: "stopped"`.
- **Story drafts show the same parts as the accepted story.** A segment without text no longer appears as an empty paragraph, and in a list of strings another kind of element no longer hides the lines after it. See [story drafts](../en/reference/plugins.md#story-drafts).
- **Event payload fields named like schema keywords reach the model.** An `emit-event` payload with a field called `definitions`, `$defs`, `default`, `enum`, `const` or `examples` lost the field, or its references stayed unresolved, in the model-facing schema.
- **Session pages stay smooth while a story is written.** A page that reads the session no longer makes the host rebuild the whole message log on every draft update, and consent checks no longer serialize large inlined pages on every render.
