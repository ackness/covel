# Documentation v2 authoring

These instructions apply to files under `docs/v2/`.

- Read `README.md` here and `../DOCS_STRATEGY.md` before adding a chapter.
- Migrate one complete reader task at a time. Start with the intended result, prerequisites and the shortest runnable path; include expected output, failure diagnosis and validation.
- Keep player instructions separate from implementation details. Explain the world/plugin/kernel boundary before introducing framework internals.
- Verify identifiers, defaults and commands against current schemas, types, routes, scripts and tests. Mark planned content explicitly.
- Test plugin examples as independent community packages. Do not depend on builtin trust, concrete plugin IDs in framework code, private APIs or machine-specific paths.
- Maintain one authoritative page for each contract. Link to existing references until their replacements are verified; preserve an old-link migration path when moving content.
- Development-agent skills should reuse tutorials and validation commands. Do not duplicate API tables or confuse them with in-game skills.
- Update this directory's reading map and migration status when a task is migrated. Do not claim that the entire v2 rewrite is complete.
- Use Chinese for explanatory prose and English/ASCII for code, identifiers, commands and code comments. Follow the repository's validation and contribution rules.
