### Fixed

- **Server logs no longer repeat the same notices every turn.** An optional service import with no provider in the session, such as the narrator's inventory tools without the inventory plugin, is logged once per session and reason. Output and event schemas that use a JSON Schema type array (`"type": ["string", "number"]`) no longer trigger an Ajv strict-mode warning.
