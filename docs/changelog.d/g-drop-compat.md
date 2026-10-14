### Breaking

- **Only the current development formats are accepted (F-073).** Regenerate traces whose payload was wrapped in `data`; recreate sessions/checkpoints containing duplicate open NPC relation versions or wrapped `dice-check` rolls/message values. Recreate wrapped `{ rule, ... }` world-rule seed records as flat rules and reimport/recreate their affected session data. Recreate portrait records that rely on arbitrary session-prefixed character IDs; exact IDs and the current `npc-<blueprintId>` mapping remain valid. Normal current-format sessions need no rebuild.
- Re-enter nested `settings.json` `entries.ui.locale` through the language selector (the stored key is `entries["ui.locale"]`). Rename bare `keys.env` provider names to `*_API_KEY`, or re-enter those keys in Settings. Unrecognized lines are preserved, warned about, and never used as credentials. Provider-ID dictionaries in APIs remain supported.
- Reimport custom themes after replacing `--surface-app`, `--surface-panel`, and `--surface-panel-strong` with `--surface-page`, `--surface-rail`, and `--surface-elevated`. The old `covel:scheme` localStorage entry is ignored; current `ui.scheme` settings remain valid. All event transport publishers must be upgraded/restarted together because `stream` is required.

### Fixed

- Plugin inputs now follow their declarations: dice receipts require `checks`, plugin-data reads use direct values, and projected narrative bindings contain strings. Obsolete resizer/preloader parameters are removed, and missing plugin labels no longer display a runtime ID. Revisionless settings backends and normal missing-data degradation remain supported.
