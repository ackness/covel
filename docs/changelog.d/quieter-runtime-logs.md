### Fixed

- **Output and event schemas that use a JSON Schema type array no longer trigger an Ajv strict-mode warning.** A schema with `"type": ["string", "number"]` is accepted without a server log warning on every turn.
