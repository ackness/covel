### Fixed

- **Scene cast no longer picks characters named inside other words or longer titles.** `scene-stage` read a character as present when any alias appeared as plain text, so "Rin" matched "spring" and "President" matched "Vice President Shiraishi". Cast selection and `npc-graph` retrieval now share `mentionedCharacterIds` from `@covel/plugin-handlers-utils`: names of spaced scripts need word boundaries and a name inside a longer name of another character does not count. Reference: `docs/reference/plugins.md`.
