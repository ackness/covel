# Legacy World Seeds

This directory stages legacy content from `../ai-gamestudio-dev` as package-owned
source material.

Rules:

- These files are not yet wired into runtime execution.
- `legacyCapabilityHints` preserve old plugin intent only; they are not current
  `covel` package names.
- Locale semantics are final here:
  - `defaultLocale` is the canonical content locale
  - `metadataLocales` declares localized metadata availability
  - `contentLocales` declares actual body locale availability
  - `localizedMetadata` uses only `zh-CN` and `en`
- The intended migration path is:
  - frontmatter `name/description` -> `World`
  - full markdown -> `Artifact`
  - heading sections -> `MemoryDocument`

Current staged assets:

- `WORLD-SPEC.md`
- `world-seeds/wuxia.md`
- `world-seeds/cyberpunk.md`
- `world-seeds/urban-xianxia.md`

Recommended next steps:

- add import tooling that maps these assets into `World + Artifact + MemoryDocument`
- keep `/world-seeds` aligned with the staged asset catalog and locale contract
- then connect `core-worldbook / core-persona / core-character-card` context
  providers to the runtime context/prompt pipeline
