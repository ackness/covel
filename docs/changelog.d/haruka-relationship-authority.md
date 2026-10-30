### Fixed

- **Harukaze Academy relationships now have one current account per subject in both languages.** All eight characters use affinity scores, preserving the five route seeds and adding the supporting characters at 5/4/6. The five routes retain their original stages, trust, pressure and event thresholds; supporting characters keep their existing non-romantic profile state. All eight keep Public Closeness. Duplicate character fields and numeric defaults are removed, and relationship memory records events and promises instead of another current account.
- **Narration can read committed affinity scores without another model call.** The affinity plugin supplies a bounded, escaped, story-only prompt segment containing canonical names and scores, without IDs, history, notes or writes. Scores are not romance stages, and omitted records are not zero.

### Upgrade notes

- **Recreate affected Harukaze development sessions, branches and snapshots from the updated world package.** Reloading does not clean old character fields, schemas, seeds or memory. Reimport world copies that embed old package data; database tables do not need rebuilding. Generic character creation still does not enforce NPC-only text-field scope. No old-data fallback, dual writing or scale conversion is provided.
