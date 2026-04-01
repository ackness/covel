# core-init-wizard

Emits a character creation form on session_start. Only fires once per session.

The wizard renders a `character_creation` UI block with a name input field.
After the player submits their name, subsequent turns use `user.input` which does not trigger this plugin.
