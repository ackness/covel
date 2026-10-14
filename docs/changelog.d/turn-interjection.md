### Fixed

- **An interjection is saved with its turn.** A message sent with "interject" during a turn used to be saved to the chat log at once, but never to the conversation history that later turns read, so the model forgot it after the turn; and a stopped or failed turn still left it in the chat log. It is now saved when its turn is saved, to both, in the same transaction, after the player's message of the turn. A turn that is not saved keeps neither. It does not count as a new player turn.
