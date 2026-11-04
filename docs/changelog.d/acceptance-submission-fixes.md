### Fixed

- **Character creation no longer ends setup before the player answers the form.** Character Creator's opening agent declares an output schema that only allows a pending setup, so a model that submits done is asked to correct it and the player character is always created from the submitted form before the opening runs. See [plugin reference](../en/reference/plugins.md#agent-output).

### Documentation

- **The agent submission check order is documented for story and system agents.** The plugin reference no longer says story agents skip the private schema check; it lists schema, story invariants, completion fields, public contract and review in the order the host applies them.
