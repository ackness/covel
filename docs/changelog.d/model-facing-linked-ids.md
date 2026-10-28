### Fixed

- **Agents that read World IR can tell who a relation or event names when characters have UUID IDs.** The model-facing projection used to drop each entity's UUID `id` but keep the relation endpoints, item holders and mixed participant lists that point to it, so downstream agents such as NPC Graph saw IDs they could not match to a name. `modelFacingJson` now keeps a UUID that links one part of a value to another, wherever it appears; UUIDs that nothing in the value names (rows, turns, results) are still left out. Rule: `docs/reference/plugins.md`.
