### Removed

- **Unreachable bundled tool registrations are removed.** `list-npc-graph`, `set-world-schema`, and `set-world-dimensions` had no runtime callers. World initialization keeps its private schema and proposal helpers behind `initialize-world`.

### Fixed

- **Schema warnings no longer recommend a plugin tool the caller cannot use.** Undeclared character fields remain a soft warning with the available attribute IDs.
- **Unprefixed local runtime references receive the correct guidance.** Validation suggests the complete package/runtime ID rather than a cross-package contract.

### Documentation

- **Bundled descriptions and create-plugin guidance match the current API.** Dice use `ctx.random`, function documentation has no Chinese prompt variant, tabletop creation reads the World Model, and character handles make no assumption about ID shape. The skill points to public result/store types and uses complete runtime IDs and author SDK imports.
