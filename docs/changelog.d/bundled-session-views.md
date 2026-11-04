### Added

- **Declarative live views can compose public story, pending interactions and the shared composer.** `SessionMessages` and `SessionComposer` use current-session host rendering with strict placement and props, recursive-context masking and ordinary action admission. Public choices retain current-turn numbering and keyboard selection, and required choices use the normal interaction submission path.
- **DM Console is a plugin page.** The runtime-free console shows public cast and interactions and composes its own input box. The relationship graph and codex keep their right panels only; use “Expand panel” for a larger view. A loaded page keeps its local display state during discovery refreshes and temporary request failures.

### Changed

- **DM Mode and Spectator include DM Console; Ensemble Dialogue recommends it.** Existing defaults, role choices and orchestration stay unchanged. Page opening adds no model call, and existing sessions keep their plugin choices.
