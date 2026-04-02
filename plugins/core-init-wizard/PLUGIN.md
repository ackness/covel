# core-init-wizard

Character creation wizard that fires on session_start. Uses LLM to generate
a narrative transition from the opening story into the character name prompt.

The handler reads the narrator's opening narrative from context, asks the LLM
to write 1-2 sentences of story-integrated transition, then emits a minimal
inline character_creation block (name only, no description).

If LLM is unavailable, falls back to a static transition line.
