# Legacy World Seeds

This directory stages legacy content from `../ai-gamestudio-dev` as package-owned
source material.

Rules:

- These files are not yet wired into runtime execution.
- `legacyPluginHints` preserve old plugin intent only; they are not current
  `covel` package names.
- The intended migration path is:
  - frontmatter `name/description` -> `World`
  - full markdown -> `Artifact`
  - heading sections -> `MemoryDocument`

Current staged assets:

- `WORLD-SPEC.md`
- `world-seeds/wuxia.md`
- `world-seeds/cyberpunk.md`
- `world-seeds/urban-xianxia.md`

Recommended next step after i18n stabilizes:

- add import tooling that maps these assets into `World + Artifact + MemoryDocument`
- then connect `core-worldbook / core-persona / core-character-card` context
  providers to the runtime context/prompt pipeline
